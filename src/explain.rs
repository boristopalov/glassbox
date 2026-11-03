//! Turns a cmudb [`Plan`] into a tree the browser can draw, numbering nodes in the same
//! pre-order as [`crate::instrument::build`] does.

use cmudb::catalog::{Catalog, Column, Schema, Value};
use cmudb::processor::plan::{
    AggType, ColIdx, Expression, JoinColumn, JoinType, Op, Plan, Side, SortDirection, SortExpr,
};
use serde::Serialize;
use std::collections::HashMap;
use std::ops::Bound;

use crate::probe::{Hint, NodeId};

#[derive(Serialize, Clone, Debug)]
pub struct PlanView {
    pub id: NodeId,
    pub op: String,
    pub title: String,
    pub detail: Vec<String>,
    pub family: &'static str,
    pub children: Vec<PlanView>,
}

/// The tree for `plan`, and the owners of the pages each node touches.
pub fn explain(catalog: &Catalog, plan: &Plan) -> (PlanView, HashMap<NodeId, Hint>) {
    let mut hints = HashMap::new();
    let mut next = 0;
    let view = Explainer {
        catalog,
        hints: &mut hints,
    }
    .node(plan, &mut next);
    (view, hints)
}

struct Explainer<'c, 'h> {
    catalog: &'c Catalog,
    hints: &'h mut HashMap<NodeId, Hint>,
}

impl Explainer<'_, '_> {
    fn table_name(&self, oid: cmudb::ids::TableOid) -> String {
        self.catalog
            .get_table(oid)
            .map(|t| t.name.clone())
            .unwrap_or_else(|_| format!("table#{oid:?}"))
    }

    fn index_name(&self, oid: cmudb::ids::IndexOid) -> (String, String) {
        match self.catalog.get_index(oid) {
            Ok(info) => (info.name.clone(), self.table_name(info.table_oid)),
            Err(_) => (format!("index#{oid:?}"), String::new()),
        }
    }

    fn first_index_of(&self, oid: cmudb::ids::TableOid) -> Option<String> {
        self.catalog
            .get_table_indexes(oid)
            .ok()
            .and_then(|v| v.first().map(|i| i.name.clone()))
    }

    fn node(&mut self, plan: &Plan, next: &mut NodeId) -> PlanView {
        let id = *next;
        *next += 1;
        let mut hint = Hint::default();
        let mut children = Vec::new();
        let (op, title, detail, family): (&str, String, Vec<String>, &'static str) = match plan {
            Plan::SeqScan(p) => {
                let t = self.table_name(p.table_oid);
                hint.table = Some(t.clone());
                ("Seq Scan", t, vec![cols(&p.schema)], "scan")
            }
            Plan::IndexScan(p) => {
                let (index, table) = self.index_name(p.index_oid);
                hint.table = Some(table.clone());
                hint.index = Some(index.clone());
                (
                    "Index Scan",
                    index,
                    vec![format!("on {table}"), range(&p.start, &p.end)],
                    "scan",
                )
            }
            Plan::Values(p) => (
                "Values",
                format!("{} row{}", p.rows.len(), plural(p.rows.len())),
                vec![cols(&p.schema)],
                "scan",
            ),
            Plan::Insert(p) => {
                let t = self.table_name(p.table_oid);
                hint.table = Some(t.clone());
                hint.index = self.first_index_of(p.table_oid);
                children.push(self.node(&p.child, next));
                ("Insert", t, vec![], "dml")
            }
            Plan::Update(p) => {
                let t = self.table_name(p.table_oid);
                hint.table = Some(t.clone());
                hint.index = self.first_index_of(p.table_oid);
                let names = &p.child.schema_ref().cols;
                let sets = p
                    .assignments
                    .iter()
                    .map(|a| {
                        let col = names
                            .get(a.col_idx.index())
                            .map_or("?".to_string(), |c| c.name.clone());
                        format!("{col} = {}", ex(&a.value, names))
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                children.push(self.node(&p.child, next));
                ("Update", t, vec![format!("set {sets}")], "dml")
            }
            Plan::Delete(p) => {
                let t = self.table_name(p.table_oid);
                hint.table = Some(t.clone());
                hint.index = self.first_index_of(p.table_oid);
                children.push(self.node(&p.child, next));
                ("Delete", t, vec![], "dml")
            }
            Plan::Filter(p) => {
                let names = &p.child.schema_ref().cols;
                let pred = ex(&p.predicate, names);
                children.push(self.node(&p.child, next));
                ("Filter", pred, vec![], "pipe")
            }
            Plan::Projection(p) => {
                let names = &p.child.schema_ref().cols;
                let list = p
                    .expressions
                    .iter()
                    .map(|e| ex(e, names))
                    .collect::<Vec<_>>()
                    .join(", ");
                children.push(self.node(&p.child, next));
                ("Project", list, vec![], "pipe")
            }
            Plan::Limit(p) => {
                children.push(self.node(&p.child, next));
                ("Limit", p.limit.to_string(), vec![], "pipe")
            }
            Plan::Aggregation(p) => {
                let names = &p.child.schema_ref().cols;
                let aggs = p
                    .aggregates
                    .iter()
                    .map(|(e, a)| agg(a, &ex(e, names)))
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut detail = Vec::new();
                if !p.group_bys.is_empty() {
                    detail.push(format!(
                        "group by {}",
                        p.group_bys
                            .iter()
                            .map(|e| ex(e, names))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                children.push(self.node(&p.child, next));
                (
                    "Aggregate",
                    if aggs.is_empty() {
                        "distinct".into()
                    } else {
                        aggs
                    },
                    detail,
                    "blocking",
                )
            }
            Plan::WindowFunction(p) => {
                let names = &p.child.schema_ref().cols;
                let aggs = p
                    .aggregates
                    .iter()
                    .map(|(e, a)| agg(a, &ex(e, names)))
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut detail = Vec::new();
                if let Some(parts) = &p.partition_by_exprs {
                    detail.push(format!(
                        "partition by {}",
                        parts
                            .iter()
                            .map(|e| ex(e, names))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if let Some(order) = &p.order_by_exprs {
                    detail.push(format!("order by {}", sort_list(order, names)));
                }
                children.push(self.node(&p.child, next));
                ("Window", aggs, detail, "blocking")
            }
            Plan::Sort(p) => {
                let names = &p.child.schema_ref().cols;
                let order = sort_list(&p.order_by_exprs, names);
                children.push(self.node(&p.child, next));
                ("Sort", order, vec!["in memory".into()], "blocking")
            }
            Plan::ExternalMergeSort(p) => {
                hint.spills = true;
                let names = &p.child.schema_ref().cols;
                let order = sort_list(&p.order_by_exprs, names);
                children.push(self.node(&p.child, next));
                (
                    "External Sort",
                    order,
                    vec!["spills sorted runs".into()],
                    "blocking",
                )
            }
            Plan::NestedLoopJoin(p) => {
                let l = &p.left.schema_ref().cols;
                let r = &p.right.schema_ref().cols;
                let pred = join_expr(&p.predicate, l, r);
                children.push(self.node(&p.left, next));
                children.push(self.node(&p.right, next));
                (
                    "Nested Loop Join",
                    pred,
                    vec![join_kind(&p.join_type)],
                    "join",
                )
            }
            Plan::NestedIndexJoin(p) => {
                let (index, table) = self.index_name(p.index_oid);
                hint.table = Some(table.clone());
                hint.index = Some(index.clone());
                let names = &p.child.schema_ref().cols;
                let key = ex(&p.key_predicate, names);
                children.push(self.node(&p.child, next));
                (
                    "Index Join",
                    format!("{table} via {index}"),
                    vec![format!("probe key {key}"), join_kind(&p.join_type)],
                    "join",
                )
            }
            Plan::HashJoin(p) => {
                hint.spills = true;
                let l = &p.left.schema_ref().cols;
                let r = &p.right.schema_ref().cols;
                let keys = p
                    .left_exprs
                    .iter()
                    .zip(&p.right_exprs)
                    .map(|(a, b)| format!("{} = {}", ex(a, l), ex(b, r)))
                    .collect::<Vec<_>>()
                    .join(" and ");
                let mut detail = vec![join_kind(&p.join_type), "partitions spill".into()];
                if let Some(res) = &p.residual {
                    detail.push(format!("residual {}", join_expr(res, l, r)));
                }
                children.push(self.node(&p.left, next));
                children.push(self.node(&p.right, next));
                ("Hash Join", keys, detail, "join")
            }
            Plan::CreateTable(p) => {
                hint.table = Some(p.table_name.clone());
                (
                    "Create Table",
                    p.table_name.clone(),
                    vec![cols(&p.schema)],
                    "ddl",
                )
            }
            Plan::DropTable(p) => (
                "Drop Table",
                p.table_oid
                    .map_or("(missing)".into(), |oid| self.table_name(oid)),
                vec![],
                "ddl",
            ),
            Plan::CreateIndex(p) => {
                let t = self.table_name(p.table_oid);
                hint.table = Some(t.clone());
                hint.index = Some(p.index_name.clone());
                (
                    "Create Index",
                    p.index_name.clone(),
                    vec![format!("on {t}")],
                    "ddl",
                )
            }
            Plan::DropIndex(p) => (
                "Drop Index",
                p.index_oid
                    .map_or("(missing)".into(), |oid| self.index_name(oid).0),
                vec![],
                "ddl",
            ),
        };
        self.hints.insert(id, hint);
        PlanView {
            id,
            op: op.to_string(),
            title,
            detail: detail.into_iter().filter(|d| !d.is_empty()).collect(),
            family,
            children,
        }
    }
}

/// The output schema of a plan node.
pub trait SchemaRef {
    fn schema_ref(&self) -> &Schema;
}

impl SchemaRef for Plan {
    fn schema_ref(&self) -> &Schema {
        match self {
            Plan::SeqScan(p) => &p.schema,
            Plan::Insert(p) => &p.schema,
            Plan::Values(p) => &p.schema,
            Plan::Update(p) => &p.schema,
            Plan::Delete(p) => &p.schema,
            Plan::IndexScan(p) => &p.schema,
            Plan::Filter(p) => &p.schema,
            Plan::Projection(p) => &p.schema,
            Plan::Aggregation(p) => &p.schema,
            Plan::NestedLoopJoin(p) => &p.schema,
            Plan::NestedIndexJoin(p) => &p.schema,
            Plan::HashJoin(p) => &p.schema,
            Plan::Sort(p) => &p.schema,
            Plan::ExternalMergeSort(p) => &p.schema,
            Plan::Limit(p) => &p.schema,
            Plan::WindowFunction(p) => &p.schema,
            Plan::CreateTable(p) => &p.schema,
            Plan::DropTable(_) | Plan::CreateIndex(_) | Plan::DropIndex(_) => empty_schema(),
        }
    }
}

fn empty_schema() -> &'static Schema {
    static EMPTY: std::sync::OnceLock<Schema> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| Schema::new(vec![]))
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn cols(schema: &Schema) -> String {
    let names: Vec<&str> = schema.cols.iter().map(|c| c.name.as_str()).collect();
    if names.len() > 5 {
        format!("{}, … ({} cols)", names[..4].join(", "), names.len())
    } else {
        names.join(", ")
    }
}

fn col_name(cols: &[Column], i: usize) -> String {
    cols.get(i)
        .map_or_else(|| format!("#{i}"), |c| c.name.clone())
}

fn value(v: &Option<Value>) -> String {
    match v {
        None => "NULL".into(),
        Some(v @ Value::TEXT(_)) => format!("'{v}'"),
        Some(v) => {
            let s = v.to_string();
            if matches!(
                v,
                Value::BOOLEAN(_) | Value::INT(_) | Value::BIGINT(_) | Value::FLOAT(_)
            ) {
                s
            } else {
                format!("'{s}'")
            }
        }
    }
}

fn op(o: &Op) -> &'static str {
    match o {
        Op::Add => "+",
        Op::Sub => "-",
        Op::Mul => "*",
        Op::Div => "/",
        Op::Eq => "=",
        Op::NEq => "<>",
        Op::Lt => "<",
        Op::Gt => ">",
        Op::Lte => "<=",
        Op::Gte => ">=",
        Op::And => "AND",
        Op::Or => "OR",
    }
}

fn ex(e: &Expression, cols: &[Column]) -> String {
    expr(e, &|i: ColIdx| col_name(cols, i.index()))
}

fn expr<C: Copy>(e: &Expression<C>, name: &dyn Fn(C) -> String) -> String {
    match e {
        Expression::Constant(v) => value(v),
        Expression::Column { col, .. } => name(*col),
        Expression::Binary { left, right, op: o } => {
            let wrap = |side: &Expression<C>| match side {
                Expression::Binary { op: inner, .. }
                    if matches!(o, Op::And) && matches!(inner, Op::Or) =>
                {
                    format!("({})", expr(side, name))
                }
                _ => expr(side, name),
            };
            format!("{} {} {}", wrap(left), op(o), wrap(right))
        }
    }
}

fn join_expr(e: &Expression<JoinColumn>, l: &[Column], r: &[Column]) -> String {
    expr(e, &|c: JoinColumn| match c.side {
        Side::Left => col_name(l, c.col.index()),
        Side::Right => col_name(r, c.col.index()),
    })
}

fn sort_list(order: &[SortExpr], names: &[Column]) -> String {
    order
        .iter()
        .map(|s| {
            let dir = match s.direction {
                SortDirection::Descending => " desc",
                _ => "",
            };
            format!("{}{dir}", ex(&s.expr, names))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn agg(a: &AggType, arg: &str) -> String {
    let name = match a {
        AggType::MAX => "max",
        AggType::MIN => "min",
        AggType::SUM => "sum",
        AggType::AVG => "avg",
        AggType::COUNT => "count",
        AggType::RANK => return "rank()".into(),
    };
    format!("{name}({arg})")
}

fn join_kind(j: &JoinType) -> String {
    match j {
        JoinType::Inner => "inner".into(),
        JoinType::Left => "left outer".into(),
    }
}

fn range(start: &Bound<Vec<Value>>, end: &Bound<Vec<Value>>) -> String {
    let show = |vals: &Vec<Value>| {
        vals.iter()
            .map(|v| value(&Some(v.clone())))
            .collect::<Vec<_>>()
            .join(", ")
    };
    match (start, end) {
        (Bound::Included(a), Bound::Included(b)) if a == b => format!("key = {}", show(a)),
        _ => {
            let lo = match start {
                Bound::Included(v) => format!("[{}", show(v)),
                Bound::Excluded(v) => format!("({}", show(v)),
                Bound::Unbounded => "(-∞".into(),
            };
            let hi = match end {
                Bound::Included(v) => format!("{}]", show(v)),
                Bound::Excluded(v) => format!("{})", show(v)),
                Bound::Unbounded => "+∞)".into(),
            };
            format!("key in {lo}, {hi}")
        }
    }
}
