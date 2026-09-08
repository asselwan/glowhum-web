import { runCreativeJob } from "../creative-jobs.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

const root = argument("--root");
const jobId = argument("--job-id");
if (!root || !jobId || !process.env.FAL_KEY) {
  console.error("Usage: FAL_KEY=... node scripts/run-creative-job.mjs --root JOB_ROOT --job-id JOB_ID");
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await runCreativeJob(root, jobId), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
