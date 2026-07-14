import "dotenv/config"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const result = await pool.query<{ id: string; articulate_url: string }>(
  `SELECT id, articulate_url FROM lessons
   WHERE content_type = 'articulate' AND articulate_url IS NOT NULL`,
)

for (const row of result.rows) {
  const url = row.articulate_url.trim()
  if (/\.html?$/i.test(url)) continue
  const normalized = url.endsWith("/") ? `${url}index.html` : `${url}/index.html`
  await pool.query(`UPDATE lessons SET articulate_url = $1 WHERE id = $2`, [normalized, row.id])
  console.log(`Updated ${row.id}: ${normalized}`)
}

await pool.end()
console.log("Done")
