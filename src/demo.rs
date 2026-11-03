//! The demo database Glass Box starts with: users and their orders, enough of them that a
//! scan of `orders` cannot fit in the buffer pool.

pub const USERS: u32 = 3_000;
pub const ORDERS: u32 = 20_000;
const ROWS_PER_INSERT: u32 = 500;

const FIRST: [&str; 24] = [
    "ada",
    "alan",
    "grace",
    "edsger",
    "barbara",
    "donald",
    "frances",
    "ken",
    "dennis",
    "radia",
    "leslie",
    "margaret",
    "john",
    "katherine",
    "linus",
    "guido",
    "bjarne",
    "anita",
    "tim",
    "shafi",
    "michael",
    "jim",
    "pat",
    "andy",
];
const LAST: [&str; 20] = [
    "lovelace",
    "turing",
    "hopper",
    "dijkstra",
    "liskov",
    "knuth",
    "allen",
    "thompson",
    "ritchie",
    "perlman",
    "lamport",
    "hamilton",
    "backus",
    "johnson",
    "torvalds",
    "rossum",
    "stroustrup",
    "borg",
    "berners",
    "goldwasser",
];
const CITIES: [&str; 12] = [
    "pittsburgh",
    "berlin",
    "tokyo",
    "lagos",
    "lima",
    "oslo",
    "austin",
    "seoul",
    "nairobi",
    "lisbon",
    "montreal",
    "taipei",
];
const STATUS: [&str; 4] = ["shipped", "pending", "returned", "delivered"];

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as u32
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.next() as usize % items.len()]
    }
}

/// The SQL that builds the demo database, in chunks small enough to run one at a time.
pub fn script() -> Vec<String> {
    let mut rng = Lcg(0x5eed_cafe);
    let mut chunks = vec![
        "CREATE TABLE users (id INT, name TEXT, city TEXT, age INT);\n\
         CREATE TABLE orders (id INT, user_id INT, amount FLOAT, status TEXT, placed_at TIMESTAMP);\n\
         CREATE INDEX users_id ON users (id);\n\
         CREATE INDEX orders_id ON orders (id);"
            .to_string(),
    ];
    for start in (1..=USERS).step_by(ROWS_PER_INSERT as usize) {
        let rows: Vec<String> = (start..(start + ROWS_PER_INSERT).min(USERS + 1))
            .map(|id| {
                let name = format!("{} {}", rng.pick(&FIRST), rng.pick(&LAST));
                let city = rng.pick(&CITIES);
                let age = 18 + rng.next() % 60;
                format!("({id}, '{name}', '{city}', {age})")
            })
            .collect();
        chunks.push(format!("INSERT INTO users VALUES {};", rows.join(", ")));
    }
    for start in (1..=ORDERS).step_by(ROWS_PER_INSERT as usize) {
        let rows: Vec<String> = (start..(start + ROWS_PER_INSERT).min(ORDERS + 1))
            .map(|id| {
                let user = 1 + rng.next() % USERS;
                let cents = 199 + rng.next() % 49_800;
                let status = rng.pick(&STATUS);
                let day = 1 + rng.next() % 28;
                let month = 1 + rng.next() % 12;
                let hour = rng.next() % 24;
                format!(
                    "({id}, {user}, {}.{:02}, '{status}', '2026-{month:02}-{day:02} {hour:02}:00:00')",
                    cents / 100,
                    cents % 100
                )
            })
            .collect();
        chunks.push(format!("INSERT INTO orders VALUES {};", rows.join(", ")));
    }
    chunks
}

/// Queries the UI offers as one-click examples, each showing off a different part of the engine.
pub const EXAMPLES: [(&str, &str); 9] = [
    ("full scan", "SELECT * FROM orders WHERE amount > 450;"),
    ("index lookup", "SELECT * FROM users WHERE id = 1337;"),
    (
        "hash join",
        "SELECT u.name, o.amount\nFROM users u JOIN orders o ON u.id = o.user_id\nWHERE o.amount > 490;",
    ),
    (
        "index join",
        "SELECT o.id, u.name, u.city\nFROM orders o JOIN users u ON o.user_id = u.id\nWHERE o.amount > 495;",
    ),
    (
        "group by",
        "SELECT city, COUNT(*), AVG(age)\nFROM users\nGROUP BY city;",
    ),
    (
        "external sort",
        "SELECT id, amount FROM orders\nORDER BY amount DESC\nLIMIT 10;",
    ),
    (
        "window",
        "SELECT name, city, age,\n  RANK() OVER (PARTITION BY city ORDER BY age DESC)\nFROM users\nWHERE age > 70;",
    ),
    (
        "update",
        "UPDATE orders SET status = 'refunded'\nWHERE amount < 3;",
    ),
    (
        "transaction",
        "BEGIN;\nINSERT INTO users VALUES (9001, 'new user', 'pittsburgh', 30);\nSELECT * FROM users WHERE id = 9001;\nROLLBACK;",
    ),
];
