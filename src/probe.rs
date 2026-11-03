//! The probe: a `log` backend that turns cmudb's buffer pool, replacer, disk and B+ tree log
//! lines into structured events, keeps a shadow model of the buffer pool, and records the
//! events of one run for replay in the browser.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;
use std::time::Instant;

pub type NodeId = u32;
pub type PageNo = u64;
pub type OwnerId = u32;

/// The four ARC lists: resident T1 (seen once) and T2 (seen twice or more), and the ghost
/// lists B1 and B2 that remember pages recently evicted from each.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    T1,
    T2,
    B1,
    B2,
}

impl Lane {
    fn index(self) -> usize {
        match self {
            Lane::T1 => 0,
            Lane::T2 => 1,
            Lane::B1 => 2,
            Lane::B2 => 3,
        }
    }

    fn from_cmudb(list: &str) -> Option<Lane> {
        match list {
            "Mru" => Some(Lane::T1),
            "Mfu" => Some(Lane::T2),
            "GhostMru" => Some(Lane::B1),
            "GhostMfu" => Some(Lane::B2),
            _ => None,
        }
    }
}

/// How a page came to sit in a frame.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoadKind {
    Miss,
    New,
    Ghost,
}

/// What a page holds, as far as the probe can tell.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageKind {
    Heap,
    Header,
    Internal,
    Leaf,
    Spill,
    Meta,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum OwnerKind {
    Table,
    Index,
    Spill,
    System,
}

/// A table, index or other user of pages, which the UI gives its own color.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub id: OwnerId,
    pub name: String,
    pub kind: OwnerKind,
}

/// One thing that happened inside the engine.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum Event {
    Stmt {
        i: usize,
    },
    Open {
        n: NodeId,
    },
    Batch {
        n: NodeId,
        rows: usize,
    },
    Done {
        n: NodeId,
    },
    Close {
        n: NodeId,
    },
    /// A hit, plus `x` more hits on the same page right after it by the same node, folded
    /// in so a scan that reads a page once per row records one event per page.
    Hit {
        p: PageNo,
        f: usize,
        w: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        n: Option<NodeId>,
        #[serde(skip_serializing_if = "is_zero")]
        x: u32,
    },
    Miss {
        p: PageNo,
        w: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        n: Option<NodeId>,
    },
    Load {
        p: PageNo,
        f: usize,
        how: LoadKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        n: Option<NodeId>,
    },
    Lane {
        p: PageNo,
        to: Option<Lane>,
    },
    Evict {
        p: PageNo,
        f: usize,
        to: Lane,
    },
    Unevict {
        p: PageNo,
        f: usize,
        to: Lane,
    },
    Free {
        p: PageNo,
    },
    Target {
        v: usize,
    },
    Pin {
        f: usize,
        on: bool,
    },
    Io {
        p: PageNo,
        w: bool,
    },
    Kind {
        p: PageNo,
        kind: PageKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        keys: Option<u32>,
    },
    Owner {
        p: PageNo,
        o: OwnerId,
    },
}

fn is_zero(x: &u32) -> bool {
    *x == 0
}

/// An event and when it happened, in microseconds since the run began.
#[derive(Serialize, Clone, Debug)]
pub struct Stamped {
    pub t: u64,
    #[serde(flatten)]
    pub e: Event,
}

/// Which owners the pages a plan node touches belong to.
#[derive(Clone, Debug, Default)]
pub struct Hint {
    pub table: Option<String>,
    pub index: Option<String>,
    pub spills: bool,
}

/// The buffer pool as the probe last saw it.
#[derive(Serialize, Clone, Debug, Default)]
pub struct PoolSnapshot {
    pub frames: Vec<Option<PageNo>>,
    pub pinned: Vec<bool>,
    pub lanes: [Vec<PageNo>; 4],
    pub target: usize,
    pub page_owner: HashMap<PageNo, OwnerId>,
    pub page_kind: HashMap<PageNo, PageKind>,
    pub page_keys: HashMap<PageNo, u32>,
    pub counters: Counters,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Counters {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub reads: u64,
    pub writes: u64,
    pub allocs: u64,
}

const MAX_RECORDED_EVENTS: usize = 600_000;

#[derive(Default)]
struct Recording {
    start: Option<Instant>,
    events: Vec<Stamped>,
    truncated: bool,
}

#[derive(Default)]
struct State {
    frames: Vec<Option<PageNo>>,
    pinned: Vec<bool>,
    lanes: [VecDeque<PageNo>; 4],
    target: usize,
    owners: Vec<Owner>,
    owner_ids: HashMap<(OwnerKind, String), OwnerId>,
    page_owner: HashMap<PageNo, OwnerId>,
    page_kind: HashMap<PageNo, PageKind>,
    page_keys: HashMap<PageNo, u32>,
    index_headers: HashMap<PageNo, String>,
    counters: Counters,
    stack: Vec<NodeId>,
    hints: HashMap<NodeId, Hint>,
    current_index: Option<String>,
    last_page: Option<PageNo>,
    pending_new: bool,
    pending_miss: bool,
    folds: HashMap<(PageNo, bool, Option<NodeId>), usize>,
    recording: Option<Recording>,
}

/// Distinct pages a stretch of hits folds into before the probe stops folding.
const MAX_FOLDS: usize = 64;

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

struct ProbeLogger;

static LOGGER: ProbeLogger = ProbeLogger;

/// Installs the probe as the process's logger. Safe to call more than once.
pub fn install() {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

/// Forgets everything about the pool, for a new database with `frames` frames.
pub fn reset(frames: usize) {
    let mut s = state().lock();
    let recording = s.recording.take();
    *s = State {
        frames: vec![None; frames],
        pinned: vec![false; frames],
        recording,
        ..State::default()
    };
    s.owner(OwnerKind::System, "catalog");
}

/// Tells the probe which page heads which index, so B+ tree pages get the right owner.
pub fn set_index_headers(headers: HashMap<PageNo, String>) {
    state().lock().index_headers = headers;
}

/// Sets which owners each plan node's pages belong to, for the statement about to run.
pub fn set_hints(hints: HashMap<NodeId, Hint>) {
    let mut s = state().lock();
    s.hints = hints;
    s.stack.clear();
}

/// Starts recording events, dropping any earlier recording.
pub fn start_recording() {
    state().lock().recording = Some(Recording {
        start: Some(Instant::now()),
        ..Recording::default()
    });
}

/// Stops recording and returns the events and whether some were dropped past the cap.
pub fn stop_recording() -> (Vec<Stamped>, bool) {
    match state().lock().recording.take() {
        Some(r) => (r.events, r.truncated),
        None => (Vec::new(), false),
    }
}

/// How many events the current recording holds.
pub fn recorded_len() -> usize {
    state()
        .lock()
        .recording
        .as_ref()
        .map_or(0, |r| r.events.len())
}

pub fn snapshot() -> PoolSnapshot {
    let s = state().lock();
    PoolSnapshot {
        frames: s.frames.clone(),
        pinned: s.pinned.clone(),
        lanes: [0, 1, 2, 3].map(|i| s.lanes[i].iter().copied().collect()),
        target: s.target,
        page_owner: s.page_owner.clone(),
        page_kind: s.page_kind.clone(),
        page_keys: s.page_keys.clone(),
        counters: s.counters.clone(),
    }
}

pub fn owners() -> Vec<Owner> {
    state().lock().owners.clone()
}

/// Records `event` from outside the engine, such as a statement boundary.
pub fn emit(event: Event) {
    state().lock().push(event);
}

/// Marks plan node `n` as running until the matching [`leave`].
pub fn enter(n: NodeId) {
    state().lock().stack.push(n);
}

pub fn leave(n: NodeId, event: Option<Event>) {
    let mut s = state().lock();
    if s.stack.last() == Some(&n) {
        s.stack.pop();
    }
    if let Some(e) = event {
        s.push(e);
    }
}

impl State {
    fn push(&mut self, e: Event) {
        match &e {
            Event::Pin { .. } => return,
            Event::Hit { .. } | Event::Kind { .. } | Event::Owner { .. } => {}
            _ => self.folds.clear(),
        }
        let Some(rec) = self.recording.as_mut() else {
            return;
        };
        if rec.events.len() >= MAX_RECORDED_EVENTS {
            rec.truncated = true;
            return;
        }
        let t = rec
            .start
            .map_or(0, |s| s.elapsed().as_micros().min(u64::MAX as u128) as u64);
        rec.events.push(Stamped { t, e });
    }

    fn owner(&mut self, kind: OwnerKind, name: &str) -> OwnerId {
        if let Some(&id) = self.owner_ids.get(&(kind, name.to_string())) {
            return id;
        }
        let id = self.owners.len() as OwnerId;
        self.owners.push(Owner {
            id,
            name: name.to_string(),
            kind,
        });
        self.owner_ids.insert((kind, name.to_string()), id);
        id
    }

    fn node(&self) -> Option<NodeId> {
        self.stack.last().copied()
    }

    fn set_owner(&mut self, p: PageNo, o: OwnerId) {
        if self.page_owner.get(&p) != Some(&o) {
            self.page_owner.insert(p, o);
            self.push(Event::Owner { p, o });
        }
    }

    fn set_kind(&mut self, p: PageNo, kind: PageKind, keys: Option<u32>) {
        let changed = self.page_kind.get(&p) != Some(&kind)
            || keys.is_some_and(|k| self.page_keys.get(&p) != Some(&k));
        self.page_kind.insert(p, kind);
        if let Some(k) = keys {
            self.page_keys.insert(p, k);
        }
        if changed {
            self.push(Event::Kind { p, kind, keys });
        }
    }

    fn hint(&self) -> Hint {
        self.node()
            .and_then(|n| self.hints.get(&n).cloned())
            .unwrap_or_default()
    }

    fn attribute(&mut self, p: PageNo, is_new: bool) {
        if let Some(name) = self.index_headers.get(&p).cloned() {
            self.current_index = Some(name.clone());
            let o = self.owner(OwnerKind::Index, &name);
            self.set_owner(p, o);
            self.set_kind(p, PageKind::Header, None);
            return;
        }
        if self.page_owner.contains_key(&p) && !is_new {
            return;
        }
        let hint = self.hint();
        let (o, kind) = if self.node().is_none() {
            (self.owner(OwnerKind::System, "catalog"), PageKind::Meta)
        } else if is_new && hint.spills {
            (self.owner(OwnerKind::Spill, "spill"), PageKind::Spill)
        } else if let Some(table) = hint.table {
            (self.owner(OwnerKind::Table, &table), PageKind::Heap)
        } else if let Some(index) = hint.index {
            (self.owner(OwnerKind::Index, &index), PageKind::Leaf)
        } else if hint.spills {
            (self.owner(OwnerKind::Spill, "spill"), PageKind::Spill)
        } else {
            (self.owner(OwnerKind::System, "catalog"), PageKind::Meta)
        };
        self.set_owner(p, o);
        if is_new || !self.page_kind.contains_key(&p) {
            self.set_kind(p, kind, None);
        }
    }

    fn classify_btree(&mut self, kind: PageKind, keys: Option<u32>) {
        let Some(p) = self.last_page else {
            return;
        };
        if kind == PageKind::Header
            && let Some(name) = self.index_headers.get(&p).cloned()
        {
            self.current_index = Some(name);
        }
        let index = self
            .current_index
            .clone()
            .or_else(|| self.hint().index)
            .unwrap_or_else(|| "index".to_string());
        let o = self.owner(OwnerKind::Index, &index);
        self.set_owner(p, o);
        self.set_kind(p, kind, keys);
    }

    fn place(&mut self, p: PageNo, f: usize) {
        for (i, slot) in self.frames.iter_mut().enumerate() {
            if i != f && *slot == Some(p) {
                *slot = None;
            }
        }
        if let Some(slot) = self.frames.get_mut(f) {
            *slot = Some(p);
        }
    }

    /// Moves `p` to the front of lane `to`, or off every lane; false if it was already there.
    fn move_lane(&mut self, p: PageNo, to: Option<Lane>) -> bool {
        if let Some(l) = to
            && self.lanes[l.index()].front() == Some(&p)
        {
            return false;
        }
        let mut was_listed = false;
        for lane in &mut self.lanes {
            let before = lane.len();
            lane.retain(|&q| q != p);
            was_listed |= lane.len() != before;
        }
        if let Some(l) = to {
            self.lanes[l.index()].push_front(p);
        }
        to.is_some() || was_listed
    }

    fn on_buffer_pool(&mut self, msg: &str) {
        let write = msg.contains("write_page");
        if msg.contains("cache hit") {
            let (Some(p), Some(f)) = (num(msg, "page_id"), num(msg, "frame_id")) else {
                return;
            };
            let f = f as usize;
            self.counters.hits += 1;
            self.last_page = Some(p);
            self.place(p, f);
            let n = self.node();
            if self.fold_hit(p, f, write, n) {
                return;
            }
            self.push(Event::Hit {
                p,
                f,
                w: write,
                n,
                x: 0,
            });
            if let Some(rec) = &self.recording
                && self.folds.len() < MAX_FOLDS
            {
                self.folds
                    .insert((p, write, n), rec.events.len().saturating_sub(1));
            }
            self.attribute(p, false);
        } else if msg.contains("cache miss") {
            let Some(p) = num(msg, "page_id") else {
                return;
            };
            self.counters.misses += 1;
            self.pending_miss = true;
            self.last_page = Some(p);
            let n = self.node();
            self.push(Event::Miss { p, w: write, n });
            self.attribute(p, false);
        } else if msg.contains("new_page requested") {
            self.pending_new = true;
        } else if msg.contains("delete_page") {
            let Some(p) = num(msg, "page_id") else {
                return;
            };
            for slot in &mut self.frames {
                if *slot == Some(p) {
                    *slot = None;
                }
            }
            self.move_lane(p, None);
            self.page_owner.remove(&p);
            self.page_kind.remove(&p);
            self.page_keys.remove(&p);
            self.push(Event::Free { p });
        }
    }

    /// Folds a hit into an earlier hit on the same page by the same node, if nothing but
    /// hits happened since.
    fn fold_hit(&mut self, p: PageNo, f: usize, w: bool, n: Option<NodeId>) -> bool {
        let Some(&event) = self.folds.get(&(p, w, n)) else {
            return false;
        };
        match self
            .recording
            .as_mut()
            .and_then(|r| r.events.get_mut(event))
        {
            Some(Stamped {
                e: Event::Hit { f: hf, x, .. },
                ..
            }) if *hf == f => {
                *x += 1;
                true
            }
            _ => false,
        }
    }

    fn on_replacer(&mut self, msg: &str) {
        if msg.starts_with("record_access") {
            let (Some(p), Some(f)) = (num(msg, "page_id"), num(msg, "frame_id")) else {
                return;
            };
            let f = f as usize;
            if msg.starts_with("record_access new") {
                let how = if std::mem::take(&mut self.pending_new) {
                    self.counters.allocs += 1;
                    LoadKind::New
                } else {
                    LoadKind::Miss
                };
                self.pending_miss = false;
                self.place(p, f);
                self.move_lane(p, Some(Lane::T1));
                self.last_page = Some(p);
                let n = self.node();
                self.push(Event::Load { p, f, how, n });
                self.attribute(p, how == LoadKind::New);
            } else if msg.contains("ghost") {
                if let Some(v) = arrow_target(msg) {
                    self.target = v;
                    self.push(Event::Target { v });
                }
                let how = if std::mem::take(&mut self.pending_new) {
                    self.counters.allocs += 1;
                    LoadKind::New
                } else {
                    LoadKind::Ghost
                };
                self.pending_miss = false;
                self.place(p, f);
                self.move_lane(p, Some(Lane::T2));
                self.last_page = Some(p);
                let n = self.node();
                self.push(Event::Load { p, f, how, n });
                self.attribute(p, how == LoadKind::New);
            } else {
                self.place(p, f);
                self.move_lane(p, Some(Lane::T2));
            }
        } else if msg.starts_with("evict_from_list: evicted") {
            let (Some(p), Some(f)) = (num(msg, "page_id"), num(msg, "frame_id")) else {
                return;
            };
            let f = f as usize;
            let to = msg
                .rsplit("-> ")
                .next()
                .and_then(|l| Lane::from_cmudb(l.trim()))
                .unwrap_or(Lane::B1);
            self.counters.evictions += 1;
            if self.frames.get(f) == Some(&Some(p)) {
                self.frames[f] = None;
            }
            self.move_lane(p, Some(to));
            self.push(Event::Evict { p, f, to });
        } else if msg.starts_with("undo_eviction") {
            let (Some(p), Some(f)) = (num(msg, "page_id"), num(msg, "frame_id")) else {
                return;
            };
            let f = f as usize;
            let to = word(msg, "list")
                .and_then(Lane::from_cmudb)
                .unwrap_or(Lane::T1);
            self.counters.evictions = self.counters.evictions.saturating_sub(1);
            self.place(p, f);
            self.move_lane(p, Some(to));
            self.push(Event::Unevict { p, f, to });
        } else if msg.starts_with("trim_ghost_tail") || msg.starts_with("remove page_id") {
            let Some(p) = num(msg, "page_id") else {
                return;
            };
            if self.move_lane(p, None) {
                self.push(Event::Lane { p, to: None });
            }
        } else if msg.starts_with("set_evictable") {
            let Some(f) = num(msg, "frame_id") else {
                return;
            };
            let f = f as usize;
            let on = word(msg, "evictable") == Some("false");
            if self.pinned.get(f).is_some_and(|&was| was != on) {
                self.pinned[f] = on;
                self.push(Event::Pin { f, on });
            }
        } else if msg.starts_with("evict: attempting")
            && let Some(v) = num(msg, "mru_target_size")
        {
            let v = v as usize;
            if v != self.target {
                self.target = v;
                self.push(Event::Target { v });
            }
        }
    }

    fn on_disk(&mut self, msg: &str) {
        let w = if msg.starts_with("read_page:") {
            false
        } else if msg.starts_with("write_page: logged") || msg.starts_with("write_page: wrote") {
            true
        } else {
            return;
        };
        let Some(p) = num(msg, "page_id") else {
            return;
        };
        if w {
            self.counters.writes += 1;
        } else {
            self.counters.reads += 1;
        }
        self.push(Event::Io { p, w });
    }

    fn on_btree(&mut self, msg: &str) {
        let Some(rest) = msg
            .strip_prefix("bptree/page_decode ")
            .or_else(|| msg.strip_prefix("bptree/page_encode "))
        else {
            return;
        };
        let kind = match word(rest, "kind") {
            Some("leaf") => PageKind::Leaf,
            Some("internal") => PageKind::Internal,
            Some("header") => PageKind::Header,
            _ => return,
        };
        let keys = num(rest, "keys").or_else(|| num(rest, "size"));
        self.classify_btree(kind, keys.map(|k| k as u32));
    }
}

/// The value after `key=` in `msg`, up to the next space or comma.
fn word<'a>(msg: &'a str, key: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(pos) = msg[from..].find(key) {
        let start = from + pos;
        let after = start + key.len();
        let boundary = start == 0
            || !msg.as_bytes()[start - 1].is_ascii_alphanumeric()
                && msg.as_bytes()[start - 1] != b'_';
        if boundary && msg[after..].starts_with('=') {
            let value = &msg[after + 1..];
            let end = value
                .find(|c: char| c.is_whitespace() || c == ',')
                .unwrap_or(value.len());
            return Some(&value[..end]);
        }
        from = after;
    }
    None
}

/// The first number in the value after `key=`, so `Some(3)` reads as 3.
fn num(msg: &str, key: &str) -> Option<u64> {
    let value = word(msg, key)?;
    let digits: String = value
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// The new value of a `mru_target_size=a->b` change.
fn arrow_target(msg: &str) -> Option<usize> {
    let value = word(msg, "mru_target_size")?;
    value.split("->").nth(1)?.parse().ok()
}

impl log::Log for ProbeLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info && metadata.target().starts_with("cmudb::")
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let target = record.target();
        let handler: fn(&mut State, &str) = match target {
            "cmudb::buffer_pool" => State::on_buffer_pool,
            "cmudb::replacer" => State::on_replacer,
            "cmudb::disk" => State::on_disk,
            "cmudb::index::b_plus_page" => State::on_btree,
            _ => return,
        };
        let msg = record.args().to_string();
        let msg = strip_tid(&msg);
        handler(&mut state().lock(), msg);
    }

    fn flush(&self) {}
}

/// `msg` without a leading `tid=ThreadId(n) ` prefix.
fn strip_tid(msg: &str) -> &str {
    match msg.strip_prefix("tid=") {
        Some(rest) => rest.split_once(' ').map_or(rest, |(_, m)| m),
        None => msg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_reads_values_at_key_boundaries() {
        let msg = "evicted frame_id=3 page_id=17 from list=Mru -> GhostMru";
        assert_eq!(word(msg, "frame_id"), Some("3"));
        assert_eq!(word(msg, "page_id"), Some("17"));
        assert_eq!(word(msg, "list"), Some("Mru"));
        assert_eq!(word("next_leaf_id=Some(4) leaf_id=9", "leaf_id"), Some("9"));
    }

    #[test]
    fn num_reads_wrapped_numbers() {
        assert_eq!(
            num("remove page_id=5 frame_id=Some(2) list=Mru", "frame_id"),
            Some(2)
        );
        assert_eq!(num("frame_id=None", "frame_id"), None);
    }

    #[test]
    fn arrow_target_reads_the_new_value() {
        let msg =
            "record_access ghost MRU hit page_id=4 frame_id=1 mru_target_size=2->3, mru_len=1";
        assert_eq!(arrow_target(msg), Some(3));
    }

    #[test]
    fn strip_tid_drops_the_thread_prefix() {
        assert_eq!(
            strip_tid("tid=ThreadId(7) read_page cache miss page_id=3"),
            "read_page cache miss page_id=3"
        );
        assert_eq!(strip_tid("evict: attempting"), "evict: attempting");
    }
}
