const healthUrl = 'http://localhost:4002/api/v1/health';
const timeoutMs = 60_000;
const startedAt = Date.now();
let lastError;

while (Date.now() - startedAt < timeoutMs) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      throw new Error(`Health endpoint returned HTTP ${response.status}`);
    }

    console.log('API is ready; starting the web app.');
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

console.error(
  `API did not become ready at ${healthUrl} within ${timeoutMs / 1_000} seconds: ${
    lastError instanceof Error ? lastError.message : 'unknown error'
  }`,
);
process.exitCode = 1;
