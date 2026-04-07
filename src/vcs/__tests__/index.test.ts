import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDisplayRef, detectWorkspace } from '../index.js';

async function withTempDir(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function withEnv(key: string, value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

describe('detectWorkspace', () => {
  it('detects svn working copies by .svn metadata', async () => {
    await withTempDir('omx-vcs-svn-', async (cwd) => {
      await mkdir(join(cwd, '.svn'), { recursive: true });
      const workspace = detectWorkspace(cwd);
      assert.equal(workspace.kind, 'svn');
      assert.equal(workspace.root, cwd);
      assert.equal(workspace.capabilities.supportsIsolatedWorkspace, false);
    });
  });
});

describe('getDisplayRef', () => {
  it('formats svn repo@revision labels', async () => {
    await withTempDir('omx-vcs-svn-display-', async (cwd) => {
      await mkdir(join(cwd, '.svn'), { recursive: true });
      const binDir = join(cwd, 'bin');
      await mkdir(binDir, { recursive: true });
      const stub = join(binDir, 'svn');
      await writeFile(
        stub,
        '#!/bin/sh\nif [ "$1" = "info" ] && [ "$2" = "--show-item" ] && [ "$3" = "revision" ]; then\n  printf "123\\n"\n  exit 0\nfi\nif [ "$1" = "info" ] && [ "$2" = "--show-item" ] && [ "$3" = "url" ]; then\n  printf "https://svn.example.com/repos/demo/trunk\\n"\n  exit 0\nfi\nif [ "$1" = "info" ] && [ "$2" = "--show-item" ] && [ "$3" = "wc-root" ]; then\n  printf ".\\n"\n  exit 0\nfi\nexit 1\n',
        'utf-8',
      );
      await chmod(stub, 0o755);
      await withEnv('PATH', `${binDir}:${process.env.PATH || ''}`, async () => {
        assert.equal(getDisplayRef(cwd), 'trunk@123');
      });
    });
  });
});
