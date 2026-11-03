//! Builds cmudb's executor tree the way its own factory does, but wraps every executor so the
//! probe sees each batch cross each edge and knows which node touched which page.

use cmudb::catalog::Schema;
use cmudb::processor::executor::{Batch, Executor, ExecutorContext, ExecutorError};
use cmudb::processor::executors::{
    AggregationExecutor, DdlExecutor, DdlOp, DeleteExecutor, ExternalMergeSortExecutor,
    FilterExecutor, HashJoinExecutor, IndexScanExecutor, InsertExecutor, LimitExecutor,
    NestedIndexJoinExecutor, NestedLoopJoinExecutor, ProjectionExecutor, SeqScanExecutor,
    SortExecutor, UpdateExecutor, ValuesExecutor, WindowFunctionExecutor,
};
use cmudb::processor::plan::Plan;

use crate::probe::{self, Event, NodeId};

struct Probed<'a> {
    id: NodeId,
    inner: Box<dyn Executor + 'a>,
}

impl Executor for Probed<'_> {
    fn open(&mut self) -> Result<(), ExecutorError> {
        probe::enter(self.id);
        let r = self.inner.open();
        probe::leave(self.id, Some(Event::Open { n: self.id }));
        r
    }

    fn next_batch(&mut self) -> Result<Option<Batch>, ExecutorError> {
        probe::enter(self.id);
        let r = self.inner.next_batch();
        let event = match &r {
            Ok(Some(b)) => Event::Batch {
                n: self.id,
                rows: b.len(),
            },
            Ok(None) | Err(_) => Event::Done { n: self.id },
        };
        probe::leave(self.id, Some(event));
        r
    }

    fn schema(&self) -> &Schema {
        self.inner.schema()
    }

    fn close(&mut self) -> Result<(), ExecutorError> {
        probe::enter(self.id);
        let r = self.inner.close();
        probe::leave(self.id, Some(Event::Close { n: self.id }));
        r
    }
}

/// The executor tree for `plan`, with nodes numbered in pre-order from `*next`, the same
/// numbering [`crate::explain::explain`] uses.
pub fn build<'a>(
    ctx: &'a ExecutorContext<'a>,
    plan: &'a Plan,
    batch_size: usize,
    next: &mut NodeId,
) -> Box<dyn Executor + 'a> {
    let id = *next;
    *next += 1;
    let catalog = ctx.catalog;
    let bpm = &ctx.bpm;
    let mut child = |p: &'a Plan| build(ctx, p, batch_size, next);
    let inner: Box<dyn Executor + 'a> = match plan {
        Plan::SeqScan(p) => Box::new(SeqScanExecutor::new(ctx, p, batch_size)),
        Plan::Values(p) => Box::new(ValuesExecutor::new(p, batch_size)),
        Plan::IndexScan(p) => Box::new(IndexScanExecutor::new(ctx, p, batch_size)),
        Plan::Insert(p) => Box::new(InsertExecutor::new(ctx, p, child(&p.child))),
        Plan::Update(p) => Box::new(UpdateExecutor::new(ctx, p, child(&p.child))),
        Plan::Delete(p) => Box::new(DeleteExecutor::new(ctx, p, child(&p.child))),
        Plan::Aggregation(p) => Box::new(AggregationExecutor::new(p, child(&p.child), batch_size)),
        Plan::NestedLoopJoin(p) => {
            let left = child(&p.left);
            let right = child(&p.right);
            Box::new(NestedLoopJoinExecutor::new(p, left, right, batch_size))
        }
        Plan::NestedIndexJoin(p) => Box::new(NestedIndexJoinExecutor::new(
            ctx,
            p,
            child(&p.child),
            batch_size,
        )),
        Plan::HashJoin(p) => {
            let left = child(&p.left);
            let right = child(&p.right);
            Box::new(HashJoinExecutor::new(
                p,
                left,
                right,
                bpm.clone(),
                batch_size,
            ))
        }
        Plan::Sort(p) => Box::new(SortExecutor::new(p, child(&p.child), batch_size)),
        Plan::ExternalMergeSort(p) => Box::new(ExternalMergeSortExecutor::new(
            p,
            child(&p.child),
            bpm.clone(),
            batch_size,
            ctx.sort_memory_budget_bytes,
        )),
        Plan::Limit(p) => Box::new(LimitExecutor::new(p, child(&p.child))),
        Plan::WindowFunction(p) => {
            Box::new(WindowFunctionExecutor::new(p, child(&p.child), batch_size))
        }
        Plan::Filter(p) => Box::new(FilterExecutor::new(p, child(&p.child))),
        Plan::Projection(p) => Box::new(ProjectionExecutor::new(p, child(&p.child))),
        Plan::CreateTable(p) => Box::new(DdlExecutor::new(
            catalog,
            bpm.clone(),
            DdlOp::CreateTable(p),
        )),
        Plan::DropTable(p) => Box::new(DdlExecutor::new(catalog, bpm.clone(), DdlOp::DropTable(p))),
        Plan::CreateIndex(p) => Box::new(DdlExecutor::new(
            catalog,
            bpm.clone(),
            DdlOp::CreateIndex(p),
        )),
        Plan::DropIndex(p) => Box::new(DdlExecutor::new(catalog, bpm.clone(), DdlOp::DropIndex(p))),
    };
    Box::new(Probed { id, inner })
}
