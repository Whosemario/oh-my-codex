import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoresearchCandidateArtifact } from '../runtime.js';

describe('parseAutoresearchCandidateArtifact', () => {
  it('accepts checkpoint fields for svn-compatible flows', () => {
    const artifact = parseAutoresearchCandidateArtifact(JSON.stringify({
      status: 'candidate',
      candidate_commit: null,
      base_commit: 'baseline',
      candidate_checkpoint_id: 'cp-2',
      base_checkpoint_id: 'cp-1',
      description: 'try a change',
      notes: ['a'],
      created_at: '2026-04-07T00:00:00.000Z',
    }));

    assert.equal(artifact.base_checkpoint_id, 'cp-1');
    assert.equal(artifact.candidate_checkpoint_id, 'cp-2');
  });
});
