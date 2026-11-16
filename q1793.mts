import postgres from 'postgres';
const sql = postgres('postgres://loom_dev:loom_dev@127.0.0.1:5434/loom_dev_t3_5b9b44cc_19550bbf');
console.log(JSON.stringify(await sql.unsafe(process.argv[2]), null, 1));
await sql.end();
