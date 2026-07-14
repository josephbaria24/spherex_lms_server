import "dotenv/config"
import pg from "pg"

const lessonId = process.argv[2] ?? "e2e0f42a-53d1-469a-b0ab-6b9d5185c730"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const result = await pool.query(
  `SELECT id, title, content_type, content, video_url, articulate_url, status, course_id
     FROM lessons WHERE id = $1`,
  [lessonId],
)
console.log(JSON.stringify(result.rows[0], null, 2))
await pool.end()
