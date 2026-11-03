process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/champion_test";
process.env.TZ = "America/Chicago";
