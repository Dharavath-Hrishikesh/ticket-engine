/// <reference types="node" />

/**
 * Load test: fires 100 concurrent lock requests at the same seat to
 * verify pessimistic locking (SELECT ... FOR UPDATE) actually enforces
 * "only one winner" under real concurrency, not just in theory.
 *
 * Run with: npx ts-node load-test.ts
 */

const BASE_URL = 'http://localhost:8080';
const TARGET_SEAT = 'F10';
const REQUEST_COUNT = 100;

interface LockResponse {
  status: 'ok' | 'error';
  message: string;
}

interface RequestOutcome {
  userId: string;
  httpStatus: number;
  body: LockResponse | null;
}

/**
 * Sends a single lock request for the target seat under the given
 * user ID. Never throws — network failures are captured as
 * httpStatus: 0 so a single dropped connection doesn't blow up
 * Promise.all for the other 99 requests.
 */
async function attemptLock(userId: string): Promise<RequestOutcome> {
  try {
    const response = await fetch(`${BASE_URL}/api/seats/${TARGET_SEAT}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked_by: userId }),
    });

    const body = (await response.json().catch(() => null)) as LockResponse | null;

    return { userId, httpStatus: response.status, body };
  } catch (err) {
    console.error(`[${userId}] Request failed:`, err);
    return { userId, httpStatus: 0, body: null };
  }
}

async function runLoadTest(): Promise<void> {
  console.log(`Firing ${REQUEST_COUNT} concurrent lock requests at seat ${TARGET_SEAT}...`);

  const requests = Array.from({ length: REQUEST_COUNT }, (_, i) => attemptLock(`user_${i + 1}`));

  const outcomes = await Promise.all(requests);

  let successCount = 0;
  let conflictCount = 0;
  let otherCount = 0;

  for (const outcome of outcomes) {
    if (outcome.httpStatus === 200) {
      successCount++;
    } else if (outcome.httpStatus === 409) {
      conflictCount++;
    } else {
      otherCount++;
    }
  }

  console.log('\n--- Load Test Results ---');
  console.log(`Total requests sent:       ${REQUEST_COUNT}`);
  console.log(`200 OK (lock acquired):    ${successCount}`);
  console.log(`409 Conflict (already locked): ${conflictCount}`);
  console.log(`Other / failed responses:  ${otherCount}`);

  if (successCount === 1) {
    console.log('\n✅ PASS: Exactly one request won the lock, as expected under pessimistic locking.');
  } else {
    console.log(`\n❌ FAIL: Expected exactly 1 successful lock, but got ${successCount}.`);
  }

  if (otherCount > 0) {
    console.log('\nNon-200/409 outcomes:');
    for (const outcome of outcomes) {
      if (outcome.httpStatus !== 200 && outcome.httpStatus !== 409) {
        console.log(`  [${outcome.userId}] status=${outcome.httpStatus} body=${JSON.stringify(outcome.body)}`);
      }
    }
  }
}

runLoadTest();