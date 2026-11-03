use glassbox::engine::{Config, Engine, Outcome};
use glassbox::probe::Event;
use parking_lot::Mutex;
use std::sync::OnceLock;

fn engine() -> &'static Mutex<Engine> {
    static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        Mutex::new(
            Engine::open(Config {
                frames: 64,
                dir: None,
                sort_budget_bytes: 64 * 1024,
                demo: true,
            })
            .expect("demo engine opens"),
        )
    })
}

fn rows(outcome: &Outcome) -> usize {
    match outcome {
        Outcome::Rows { total, .. } => *total,
        other => panic!("expected rows, got {other:?}"),
    }
}

#[test]
fn demo_tables_hold_their_rows() {
    let mut e = engine().lock();
    let run = e.run("SELECT COUNT(*) FROM orders;", 64);
    match &run.statements[0].outcome {
        Outcome::Rows { rows, .. } => assert_eq!(rows[0][0].as_deref(), Some("20000")),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn a_scan_streams_batches_up_the_plan_and_misses_the_pool() {
    let mut e = engine().lock();
    let run = e.run("SELECT * FROM orders WHERE amount > 450;", 64);
    let stmt = &run.statements[0];
    let total = rows(&stmt.outcome);
    assert!(total > 0, "some orders are over 450");
    let plan = stmt.plan.as_ref().expect("a plan");
    let root = plan.id;
    let out: usize = run
        .events
        .iter()
        .filter_map(|s| match s.e {
            Event::Batch { n, rows } if n == root => Some(rows),
            _ => None,
        })
        .sum();
    assert_eq!(out, total, "the root's batches add up to the result");
    let misses = run
        .events
        .iter()
        .filter(|s| matches!(s.e, Event::Miss { .. }))
        .count();
    let evictions = run
        .events
        .iter()
        .filter(|s| matches!(s.e, Event::Evict { .. }))
        .count();
    assert!(
        misses > 64,
        "a scan of orders does not fit in 64 frames: {misses} misses"
    );
    assert!(evictions > 0, "so it evicts");
}

#[test]
fn an_index_lookup_reads_btree_pages() {
    let mut e = engine().lock();
    let run = e.run("SELECT * FROM users WHERE id = 1337;", 64);
    assert_eq!(rows(&run.statements[0].outcome), 1);
    let plan = run.statements[0].plan.as_ref().expect("a plan");
    let ops = format!("{plan:?}");
    assert!(ops.contains("Index Scan"), "planner picks the index: {ops}");
    let index_owner = run
        .owners
        .iter()
        .find(|o| o.name == "users_id")
        .expect("users_id owns pages");
    let index_pages = run
        .after
        .page_owner
        .values()
        .filter(|&&o| o == index_owner.id)
        .count();
    assert!(index_pages >= 2, "header plus at least one tree page");
}

#[test]
fn an_external_sort_spills_runs() {
    let mut e = engine().lock();
    let run = e.run(
        "SELECT id, amount FROM orders ORDER BY amount DESC LIMIT 10;",
        64,
    );
    assert_eq!(rows(&run.statements[0].outcome), 10);
    let news = run
        .events
        .iter()
        .filter(|s| {
            matches!(
                s.e,
                Event::Load {
                    how: glassbox::probe::LoadKind::New,
                    ..
                }
            )
        })
        .count();
    let frees = run
        .events
        .iter()
        .filter(|s| matches!(s.e, Event::Free { .. }))
        .count();
    assert!(news > 0, "the sort writes runs to new pages");
    assert!(frees > 0, "and frees them once merged");
}

#[test]
fn transactions_roll_back() {
    let mut e = engine().lock();
    let run = e.run(
        "BEGIN; INSERT INTO users VALUES (9001, 'x', 'y', 1); SELECT * FROM users WHERE id = 9001; ROLLBACK;",
        64,
    );
    assert_eq!(run.statements.len(), 4);
    assert_eq!(rows(&run.statements[2].outcome), 1);
    let after = e.run("SELECT * FROM users WHERE id = 9001;", 64);
    assert_eq!(rows(&after.statements[0].outcome), 0);
}

#[test]
fn errors_stop_the_run() {
    let mut e = engine().lock();
    let run = e.run("SELECT * FROM nope; SELECT 1;", 64);
    assert_eq!(run.statements.len(), 1);
    assert!(matches!(run.statements[0].outcome, Outcome::Error { .. }));
}

#[test]
fn every_query_kind_runs() {
    let mut e = engine().lock();
    for (label, sql) in glassbox::demo::EXAMPLES {
        let run = e.run(sql, 64);
        for s in &run.statements {
            assert!(
                !matches!(s.outcome, Outcome::Error { .. }),
                "{label}: {} failed: {:?}",
                s.sql,
                s.outcome
            );
        }
    }
}

#[test]
fn the_shadow_pool_matches_the_real_one() {
    let mut e = engine().lock();
    for sql in [
        "SELECT * FROM orders WHERE amount > 450;",
        "SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE o.amount > 490;",
        "SELECT id, amount FROM orders ORDER BY amount DESC LIMIT 10;",
        "SELECT * FROM users WHERE id = 7;",
    ] {
        let run = e.run(sql, 64);
        let mut shadow: Vec<u64> = run.after.frames.iter().flatten().copied().collect();
        shadow.sort();
        let mut real = e.resident_pages();
        real.sort();
        assert_eq!(shadow, real, "after {sql}");
        let json = serde_json::to_string(&run).expect("serializes");
        eprintln!(
            "{sql}: {} events, {} KB",
            run.events.len(),
            json.len() / 1024
        );
    }
}
