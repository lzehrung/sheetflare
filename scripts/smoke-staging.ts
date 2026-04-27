import {
  assert,
  assertPresent,
  logStep,
  logSuccess,
  requestJson,
  ScriptError
} from './lib/runtime';
import { readSmokeConfig } from './lib/smoke-config';

type RowEnvelope = {
  id: string;
  rowNumber: number;
  values: Record<string, unknown>;
};

type ListRowsResponse = {
  data: RowEnvelope[];
  nextCursor: string | null;
};

type CacheStatusResponse = {
  data: {
    status: string;
    stale: boolean;
    staleReason: string;
    rowCount: number;
  };
};

type CreateRowResponse = {
  data: RowEnvelope;
  ignoredKeys: string[];
};

type GetRowResponse = {
  data: RowEnvelope;
};

type DeleteRowResponse = {
  ok: true;
  deletedId: string;
};

type ReindexResponse = {
  ok: true;
  rowCount: number;
  cache: {
    status: string;
    staleReason: string;
  };
};

async function expectStatus(
  baseUrl: string,
  path: string,
  expectedStatus: number,
  init?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
  }
) {
  const request = {
    baseUrl,
    path,
    expectedStatus
  };
  const { response } = await requestJson<unknown>({
    ...request,
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {})
  });
  return response.status;
}

async function main() {
  const {
    baseUrl,
    adminCredential,
    privateProject,
    privateTable,
    privateReadKey,
    mutationKey,
    publicProject,
    publicTable,
    idColumn,
    createValues,
    updateValues
  } = readSmokeConfig();
  const smokeId = `smoke-${Date.now()}`;
  let createdRowId: string | null = null;

  try {
    logStep('Internal readiness check');
    const readiness = await requestJson<{
      checks: {
        controlPlane: string;
        rateLimit: string;
      };
    }>({
      baseUrl,
      path: '/ready',
      expectedStatus: 200
    });
    const readinessData = assertPresent(readiness.data, 'Readiness check returned an empty response body.');
    assert(readinessData.checks.controlPlane === 'ok', 'Readiness check reported control-plane failure.');
    assert(readinessData.checks.rateLimit === 'ok', 'Readiness check reported rate-limit failure.');
    logSuccess('Readiness endpoint reported healthy internal checks');

    logStep('Admin project listing');
    await requestJson({
      baseUrl,
      path: '/v1/admin/projects',
      bearer: adminCredential,
      expectedStatus: 200
    });
    logSuccess('Admin routes are reachable');

    logStep('Private table rejects anonymous reads');
    await expectStatus(
      baseUrl,
      `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
      401
    );
    logSuccess('Private table blocks anonymous reads');

    logStep('Private table accepts scoped read key');
    await requestJson<ListRowsResponse>({
      baseUrl,
      path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
      bearer: privateReadKey,
      expectedStatus: 200
    });
    logSuccess('Private table read key works');

    logStep('Public table accepts anonymous reads');
    await requestJson<ListRowsResponse>({
      baseUrl,
      path: `/v1/projects/${encodeURIComponent(publicProject)}/tables/${encodeURIComponent(publicTable)}/rows`,
      expectedStatus: 200
    });
    logSuccess('Public-read table works anonymously');

    logStep('Public-read table rejects anonymous writes');
    await expectStatus(
      baseUrl,
      `/v1/projects/${encodeURIComponent(publicProject)}/tables/${encodeURIComponent(publicTable)}/rows`,
      401,
      {
        method: 'POST',
        body: {
          values: {
            ...createValues,
            [idColumn]: `public-${smokeId}`
          }
        }
      }
    );
    logSuccess('Public-read table blocks anonymous writes');

    logStep('Cache status includes stale reason');
    const cacheStatus = await requestJson<CacheStatusResponse>({
      baseUrl,
      path: `/v1/admin/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/cache`,
      bearer: adminCredential,
      expectedStatus: 200
    });
    const cacheStatusData = assertPresent(cacheStatus.data, 'Cache status returned an empty response body.');
    assert(typeof cacheStatusData.data.staleReason === 'string', 'Cache status must include staleReason.');
    logSuccess(`Cache status is ${cacheStatusData.data.status}/${cacheStatusData.data.staleReason}`);

    logStep('Create a smoke row');
    const createResponse = await requestJson<CreateRowResponse>({
      baseUrl,
      path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
      method: 'POST',
      bearer: mutationKey,
      expectedStatus: 201,
      body: {
        values: {
          ...createValues,
          [idColumn]: smokeId
        }
      }
    });
    const createdRow = assertPresent(createResponse.data, 'Create row returned an empty response body.');
    createdRowId = createdRow.data.id;
    assert(createdRowId === smokeId, `Expected created row id ${smokeId}, received ${createdRowId}.`);
    logSuccess(`Created smoke row ${createdRowId}`);

    logStep('Read the smoke row back');
    const getResponse = await requestJson<GetRowResponse>({
      baseUrl,
      path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
      bearer: privateReadKey,
      expectedStatus: 200
    });
    const fetchedRow = assertPresent(getResponse.data, 'Get row returned an empty response body.');
    assert(fetchedRow.data.id === smokeId, 'Smoke row get did not return the expected row.');
    logSuccess('Smoke row get returned the expected id');

    logStep('Update the smoke row');
    await requestJson<CreateRowResponse>({
      baseUrl,
      path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
      method: 'PATCH',
      bearer: mutationKey,
      expectedStatus: 200,
      body: {
        values: updateValues
      }
    });
    logSuccess('Smoke row update succeeded');

    logStep('Force a reindex');
    const reindexResponse = await requestJson<ReindexResponse>({
      baseUrl,
      path: `/v1/admin/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/reindex`,
      method: 'POST',
      bearer: adminCredential,
      expectedStatus: 200
    });
    const reindexData = assertPresent(reindexResponse.data, 'Reindex returned an empty response body.');
    assert(reindexData.ok === true, 'Reindex did not succeed.');
    logSuccess(`Reindex succeeded with cache state ${reindexData.cache.status}/${reindexData.cache.staleReason}`);

    logStep('Delete the smoke row');
    const deleteResponse = await requestJson<DeleteRowResponse>({
      baseUrl,
      path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
      method: 'DELETE',
      bearer: mutationKey,
      expectedStatus: 200
    });
    const deletedRow = assertPresent(deleteResponse.data, 'Delete row returned an empty response body.');
    assert(deletedRow.deletedId === smokeId, 'Delete did not remove the expected row.');
    createdRowId = null;
    logSuccess('Smoke row delete succeeded');

    console.log('\n[done] staging smoke checks passed');
  } catch (error) {
    if (createdRowId) {
      try {
        logStep(`Cleanup deleting smoke row ${createdRowId}`);
        await requestJson<DeleteRowResponse>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(createdRowId)}`,
          method: 'DELETE',
          bearer: mutationKey,
          expectedStatus: 200
        });
        logSuccess('Cleanup delete succeeded');
      } catch (cleanupError) {
        console.error(
          cleanupError instanceof Error
            ? cleanupError.message
            : `Cleanup failed: ${String(cleanupError)}`
        );
      }
    }

    throw error;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof ScriptError || error instanceof Error
    ? error.message
    : String(error);
  console.error(`\n[failed] ${message}`);
  process.exit(1);
});
