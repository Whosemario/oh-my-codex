import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimTask,
  createTask,
  initTeamState,
  transitionTaskStatus,
} from '../state.js';

async function withTempDir(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('shared workspace lock', () => {
  it('serializes svn code-change tasks with workspace.lock', async () => {
    await withTempDir('omx-team-shared-lock-', async (cwd) => {
      await initTeamState(
        'shared-lock',
        'serialize svn writes',
        'executor',
        2,
        cwd,
        undefined,
        process.env,
        {
          workspace_mode: 'shared',
          workspace_vcs_kind: 'svn',
          leader_cwd: cwd,
        },
      );

      const taskA = await createTask('shared-lock', {
        subject: 'write-a',
        description: 'first writer',
        status: 'pending',
        requires_code_change: true,
      }, cwd);
      const taskB = await createTask('shared-lock', {
        subject: 'write-b',
        description: 'second writer',
        status: 'pending',
        requires_code_change: true,
      }, cwd);

      const claimA = await claimTask('shared-lock', taskA.id, 'worker-1', null, cwd);
      assert.equal(claimA.ok, true);
      const lockPath = join(cwd, '.omx', 'state', 'team', 'shared-lock', 'workspace.lock');
      assert.equal(existsSync(lockPath), true);

      const claimB = await claimTask('shared-lock', taskB.id, 'worker-2', null, cwd);
      assert.equal(claimB.ok, false);
      if (!claimB.ok) {
        assert.equal(claimB.error, 'claim_conflict');
      }

      if (!claimA.ok) throw new Error('expected first claim to succeed');
      const completed = await transitionTaskStatus(
        'shared-lock',
        taskA.id,
        'in_progress',
        'completed',
        claimA.claimToken,
        cwd,
        { result: 'done' },
      );
      assert.equal(completed.ok, true);
      assert.equal(existsSync(lockPath), false);

      const retryClaimB = await claimTask('shared-lock', taskB.id, 'worker-2', null, cwd);
      assert.equal(retryClaimB.ok, true);
    });
  });
});
