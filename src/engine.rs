//! Runs SQL on a cmudb [`Database`] through the instrumented executors and records what
//! happened for the browser to replay.

use cmudb::Database;
use cmudb::concurrency::{IsolationLevel, Transaction};
use cmudb::processor::executor::{ExecutorContext, ExecutorError, rows_affected};
use cmudb::processor::plan::Plan;
use serde::Serialize;
use sqlparser::ast::Statement;
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crate::explain::{PlanView, explain};
use crate::instrument;
use crate::probe::{self, Event, Owner, PoolSnapshot, Stamped};

/// Result rows past this many are counted but not sent.
pub const MAX_RESULT_ROWS: usize = 500;

#[derive(Clone, Debug)]
pub struct Config {
    pub frames: usize,
    pub dir: Option<PathBuf>,
    pub sort_budget_bytes: usize,
    pub demo: bool,
}

pub struct Engine {
    db: Database,
    config: Config,
    block: Block,
}

enum Block {
    None,
    Open(Arc<Transaction>),
    Failed,
}

#[derive(Serialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Rows {
        columns: Vec<String>,
        rows: Vec<Vec<Option<String>>>,
        total: usize,
    },
    Count {
        op: String,
        rows: u64,
    },
    Message {
        text: String,
    },
    Error {
        text: String,
    },
}

#[derive(Serialize, Debug)]
pub struct StatementRun {
    pub sql: String,
    pub plan: Option<PlanView>,
    pub outcome: Outcome,
    pub events: (usize, usize),
    pub micros: u64,
}

#[derive(Serialize, Debug)]
pub struct Run {
    pub statements: Vec<StatementRun>,
    pub events: Vec<Stamped>,
    pub truncated: bool,
    pub before: PoolSnapshot,
    pub after: PoolSnapshot,
    pub owners: Vec<Owner>,
    pub in_transaction: bool,
    pub micros: u64,
}

#[derive(Serialize, Debug)]
pub struct TableInfo {
    pub name: String,
    pub columns: Vec<(String, String)>,
    pub indexes: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct State {
    pub frames: usize,
    pub pool: PoolSnapshot,
    pub owners: Vec<Owner>,
    pub tables: Vec<TableInfo>,
    pub pages_allocated: usize,
    pub in_transaction: bool,
    pub persistent: bool,
}

impl Engine {
    pub fn open(config: Config) -> Result<Self, String> {
        probe::install();
        probe::reset(config.frames);
        let db = match &config.dir {
            Some(dir) => Database::open(dir, config.frames)
                .map_err(|e| format!("cannot open the database in {}: {e}", dir.display()))?,
            None => Database::scratch(config.frames).map_err(|e| e.to_string())?,
        };
        let fresh = db.catalog().snapshot().tables.is_empty();
        let mut engine = Self {
            db,
            config,
            block: Block::None,
        };
        engine.refresh_headers();
        if engine.config.demo && fresh {
            engine.seed()?;
        }
        Ok(engine)
    }

    /// Replaces the database with a fresh one built from the same config.
    pub fn reset(&mut self) -> Result<(), String> {
        if let Block::Open(txn) = std::mem::replace(&mut self.block, Block::None) {
            let _ = self.db.txn_mgr().abort(&txn);
        }
        let config = self.config.clone();
        let fresh = Engine::open(Config {
            dir: None,
            ..config.clone()
        })?;
        let old = std::mem::replace(self, fresh);
        drop(old);
        self.config = config;
        Ok(())
    }

    /// Every page the buffer pool holds right now, asked of the pool itself.
    pub fn resident_pages(&self) -> Vec<u64> {
        let bpm = self.db.bpm();
        (0..bpm.allocated_page_count())
            .filter_map(|i| u32::try_from(i).ok())
            .map(cmudb::ids::PageId::new)
            .filter(|&p| bpm.is_resident(p))
            .map(|p| p.as_usize() as u64)
            .collect()
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn state(&self) -> State {
        let snap = self.db.catalog().snapshot();
        let tables = snap
            .tables
            .iter()
            .map(|t| TableInfo {
                name: t.name.clone(),
                columns: t
                    .columns
                    .iter()
                    .map(|(ty, name)| (name.clone(), format!("{ty:?}")))
                    .collect(),
                indexes: snap
                    .indexes
                    .iter()
                    .filter(|i| i.table_oid == t.oid)
                    .map(|i| i.name.clone())
                    .collect(),
            })
            .collect();
        State {
            frames: self.config.frames,
            pool: probe::snapshot(),
            owners: probe::owners(),
            tables,
            pages_allocated: self.db.bpm().allocated_page_count(),
            in_transaction: !matches!(self.block, Block::None),
            persistent: self.config.dir.is_some(),
        }
    }

    fn refresh_headers(&self) {
        let snap = self.db.catalog().snapshot();
        probe::set_index_headers(
            snap.indexes
                .iter()
                .map(|i| (i.header_page_id.as_usize() as u64, i.name.clone()))
                .collect(),
        );
    }

    /// Runs every statement in `sql`, stopping at the first that fails, and returns the
    /// recorded trace.
    pub fn run(&mut self, sql: &str, batch_size: usize) -> Run {
        let started = Instant::now();
        let before = probe::snapshot();
        probe::start_recording();
        let mut statements = Vec::new();
        match Parser::parse_sql(&GenericDialect, sql) {
            Err(e) => statements.push(StatementRun {
                sql: sql.trim().to_string(),
                plan: None,
                outcome: Outcome::Error {
                    text: format!("syntax error: {e}"),
                },
                events: (0, 0),
                micros: 0,
            }),
            Ok(parsed) => {
                for (i, stmt) in parsed.iter().enumerate() {
                    let start = probe::recorded_len();
                    probe::emit(Event::Stmt { i });
                    let t0 = Instant::now();
                    let (plan, outcome) = self.statement(stmt, batch_size.max(1));
                    let failed = matches!(outcome, Outcome::Error { .. });
                    statements.push(StatementRun {
                        sql: stmt.to_string(),
                        plan,
                        outcome,
                        events: (start, probe::recorded_len()),
                        micros: t0.elapsed().as_micros() as u64,
                    });
                    self.refresh_headers();
                    if failed {
                        break;
                    }
                }
            }
        }
        let (events, truncated) = probe::stop_recording();
        Run {
            statements,
            events,
            truncated,
            before,
            after: probe::snapshot(),
            owners: probe::owners(),
            in_transaction: !matches!(self.block, Block::None),
            micros: started.elapsed().as_micros() as u64,
        }
    }

    fn statement(&mut self, stmt: &Statement, batch_size: usize) -> (Option<PlanView>, Outcome) {
        match stmt {
            Statement::StartTransaction { .. } => (None, self.begin()),
            Statement::Commit { .. } => (None, self.end(true)),
            Statement::Rollback { .. } => (None, self.end(false)),
            _ => {
                if matches!(self.block, Block::Failed) {
                    return (
                        None,
                        Outcome::Error {
                            text: "the transaction failed; ROLLBACK to end it".into(),
                        },
                    );
                }
                let plan = match self.db.plan(&stmt.to_string()) {
                    Ok(mut plans) if plans.len() == 1 => plans.remove(0),
                    Ok(_) => {
                        return (
                            None,
                            Outcome::Error {
                                text: "expected one statement".into(),
                            },
                        );
                    }
                    Err(e) => {
                        return (
                            None,
                            Outcome::Error {
                                text: e.to_string(),
                            },
                        );
                    }
                };
                let (view, hints) = explain(self.db.catalog(), &plan);
                probe::set_hints(hints);
                let outcome = self.execute(&plan, batch_size);
                probe::set_hints(HashMap::new());
                (Some(view), outcome)
            }
        }
    }

    fn begin(&mut self) -> Outcome {
        if !matches!(self.block, Block::None) {
            return Outcome::Error {
                text: "already in a transaction".into(),
            };
        }
        self.block = Block::Open(self.db.txn_mgr().begin(IsolationLevel::SnapshotIsolation));
        Outcome::Message {
            text: "BEGIN".into(),
        }
    }

    fn end(&mut self, commit: bool) -> Outcome {
        match std::mem::replace(&mut self.block, Block::None) {
            Block::None => Outcome::Error {
                text: "no transaction is open".into(),
            },
            Block::Failed => Outcome::Message {
                text: "ROLLBACK".into(),
            },
            Block::Open(txn) => match self.finish(&txn, commit) {
                Ok(()) => Outcome::Message {
                    text: if commit { "COMMIT" } else { "ROLLBACK" }.into(),
                },
                Err(e) => Outcome::Error { text: e },
            },
        }
    }

    fn finish(&self, txn: &Transaction, commit: bool) -> Result<(), String> {
        let mgr = self.db.txn_mgr();
        if commit {
            if let Err(e) = mgr.commit(txn) {
                let _ = mgr.abort(txn);
                return Err(format!("commit failed, rolled back: {e}"));
            }
        } else {
            mgr.abort(txn)
                .map_err(|e| format!("rollback failed: {e}"))?;
        }
        let _ = mgr.garbage_collect();
        if commit {
            self.db
                .checkpoint()
                .map_err(|e| format!("checkpoint failed: {e}"))?;
        }
        Ok(())
    }

    fn execute(&mut self, plan: &Plan, batch_size: usize) -> Outcome {
        let (txn, autocommit) = match &self.block {
            Block::Open(txn) => (txn.clone(), false),
            _ => (
                self.db.txn_mgr().begin(IsolationLevel::SnapshotIsolation),
                true,
            ),
        };
        let result = self.run_plan(&txn, plan, batch_size);
        match result {
            Ok(outcome) => {
                if autocommit && let Err(text) = self.finish(&txn, true) {
                    return Outcome::Error { text };
                }
                outcome
            }
            Err(e) => {
                let _ = self.finish(&txn, false);
                if !autocommit {
                    self.block = Block::Failed;
                }
                Outcome::Error {
                    text: if autocommit {
                        e.to_string()
                    } else {
                        format!("{e} (the transaction is rolled back)")
                    },
                }
            }
        }
    }

    fn run_plan(
        &self,
        txn: &Arc<Transaction>,
        plan: &Plan,
        batch_size: usize,
    ) -> Result<Outcome, ExecutorError> {
        let ctx = ExecutorContext::new(
            self.db.catalog(),
            self.db.bpm().clone(),
            txn.clone(),
            self.db.txn_mgr().clone(),
        )
        .with_sort_memory_budget(self.config.sort_budget_bytes);
        let mut next = 0;
        let mut exec = instrument::build(&ctx, plan, batch_size, &mut next);
        exec.open()?;
        let outcome = match plan {
            Plan::Insert(_) | Plan::Update(_) | Plan::Delete(_) => {
                let op = match plan {
                    Plan::Insert(_) => "INSERT",
                    Plan::Update(_) => "UPDATE",
                    _ => "DELETE",
                };
                Outcome::Count {
                    op: op.into(),
                    rows: rows_affected(plan, &mut *exec)?,
                }
            }
            Plan::CreateTable(p) => {
                exec.next_batch()?;
                Outcome::Message {
                    text: format!("CREATE TABLE {}", p.table_name),
                }
            }
            Plan::CreateIndex(p) => {
                exec.next_batch()?;
                Outcome::Message {
                    text: format!("CREATE INDEX {}", p.index_name),
                }
            }
            Plan::DropTable(_) => {
                exec.next_batch()?;
                Outcome::Message {
                    text: "DROP TABLE".into(),
                }
            }
            Plan::DropIndex(_) => {
                exec.next_batch()?;
                Outcome::Message {
                    text: "DROP INDEX".into(),
                }
            }
            _ => {
                let schema = exec.schema().clone();
                let columns = schema.cols.iter().map(|c| c.name.clone()).collect();
                let mut rows = Vec::new();
                let mut total = 0;
                while let Some(batch) = exec.next_batch()? {
                    for (tuple, _) in batch.iter() {
                        total += 1;
                        if rows.len() < MAX_RESULT_ROWS {
                            let row = schema
                                .cols
                                .iter()
                                .enumerate()
                                .map(|(i, col)| {
                                    Ok(schema
                                        .get_value(tuple, i)?
                                        .map(|v| v.padded_for(col.dtype).to_string()))
                                })
                                .collect::<Result<Vec<_>, cmudb::catalog::CatalogError>>()?;
                            rows.push(row);
                        }
                    }
                }
                Outcome::Rows {
                    columns,
                    rows,
                    total,
                }
            }
        };
        exec.close()?;
        Ok(outcome)
    }

    fn seed(&mut self) -> Result<(), String> {
        for chunk in crate::demo::script() {
            let run = self.run(&chunk, 1024);
            for s in &run.statements {
                if let Outcome::Error { text } = &s.outcome {
                    return Err(format!("seeding the demo data failed on {}: {text}", s.sql));
                }
            }
        }
        Ok(())
    }
}
