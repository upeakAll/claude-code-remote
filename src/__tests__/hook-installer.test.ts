import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadTemplate, installHooks, uninstallHooks, isHooksInstalled } from '../hooks/hook-installer.js';

describe('hook-installer', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  describe('loadTemplate()', () => {
    it('loads template with default port 9876', () => {
      const config = loadTemplate();
      expect(config.hooks.PreToolUse).toHaveLength(1);
      expect(config.hooks.PostToolUse).toHaveLength(1);
      expect(config.hooks.Notification).toHaveLength(1);

      expect(config.hooks.PreToolUse[0].command).toContain('127.0.0.1:9876');
      expect(config.hooks.PreToolUse[0].command).toContain('$REMOTE_TOKEN');
      expect(config.hooks.PreToolUse[0].command).toContain('$PAYLOAD');
    });

    it('replaces port when non-default port is given', () => {
      const config = loadTemplate(5555);
      expect(config.hooks.PreToolUse[0].command).toContain('127.0.0.1:5555');
      expect(config.hooks.PreToolUse[0].command).not.toContain('9876');
      expect(config.hooks.PostToolUse[0].command).toContain('127.0.0.1:5555');
      expect(config.hooks.Notification[0].command).toContain('127.0.0.1:5555');
    });

    it('returns default template when port is 9876', () => {
      const config = loadTemplate(9876);
      expect(config.hooks.PreToolUse[0].command).toContain('127.0.0.1:9876');
    });

    it('loads template with Stop hook entry', () => {
      const config = loadTemplate();
      expect(config.hooks.Stop).toBeDefined();
      expect(config.hooks.Stop).toHaveLength(1);
      expect(config.hooks.Stop[0].command).toContain('127.0.0.1:9876');
    });

    it('replaces port in Stop hook for custom port', () => {
      const config = loadTemplate(5555);
      expect(config.hooks.Stop[0].command).toContain('127.0.0.1:5555');
    });

    it('preserves matcher and command structure', () => {
      const config = loadTemplate();
      for (const entries of Object.values(config.hooks)) {
        for (const entry of entries) {
          expect(entry).toHaveProperty('matcher');
          expect(entry).toHaveProperty('command');
          expect(typeof entry.matcher).toBe('string');
          expect(typeof entry.command).toBe('string');
        }
      }
    });
  });

  describe('installHooks()', () => {
    it('creates .claude/settings.json with hooks', () => {
      installHooks(tmpdir);

      const settingsPath = path.join(tmpdir, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PostToolUse).toHaveLength(1);
      expect(settings.hooks.Notification).toHaveLength(1);
      expect(settings.hooks.Stop).toHaveLength(1);
    });

    it('installs hooks with custom port', () => {
      installHooks(tmpdir, 5555);

      const settingsPath = path.join(tmpdir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse[0].command).toContain('127.0.0.1:5555');
    });

    it('merges into existing settings without overwriting other keys', () => {
      const settingsDir = path.join(tmpdir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      const settingsPath = path.join(settingsDir, 'settings.json');

      const existingSettings = {
        someOtherKey: 'preserved',
        hooks: {
          PreToolUse: [{ matcher: 'existing', command: 'existing-command' }],
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

      installHooks(tmpdir);

      const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(merged.someOtherKey).toBe('preserved');
      expect(merged.hooks.PreToolUse).toHaveLength(2);
      expect(merged.hooks.PreToolUse[0].command).toBe('existing-command');
      expect(merged.hooks.PreToolUse[1].command).toContain('127.0.0.1:9876');
    });

    it('does not add duplicate hooks', () => {
      installHooks(tmpdir);
      installHooks(tmpdir);

      const settingsPath = path.join(tmpdir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PostToolUse).toHaveLength(1);
    });
  });

  describe('uninstallHooks()', () => {
    it('removes hook entries containing 127.0.0.1', () => {
      installHooks(tmpdir);

      uninstallHooks(tmpdir);

      const settingsPath = path.join(tmpdir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks).toBeUndefined();
    });

    it('preserves other hook entries not containing 127.0.0.1', () => {
      const settingsDir = path.join(tmpdir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      const settingsPath = path.join(settingsDir, 'settings.json');

      const existingSettings = {
        hooks: {
          PreToolUse: [
            { matcher: '', command: 'curl -s -X POST http://127.0.0.1:9876/hook -d test' },
            { matcher: 'Bash', command: 'some-other-script.sh' },
          ],
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

      uninstallHooks(tmpdir);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].command).toBe('some-other-script.sh');
    });

    it('does nothing if settings.json does not exist', () => {
      expect(() => uninstallHooks(tmpdir)).not.toThrow();
    });

    it('does nothing if settings.json has no hooks', () => {
      const settingsDir = path.join(tmpdir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      const settingsPath = path.join(settingsDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({ someKey: 'value' }, null, 2));

      uninstallHooks(tmpdir);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.someKey).toBe('value');
      expect(settings.hooks).toBeUndefined();
    });
  });

  describe('isHooksInstalled()', () => {
    it('returns false when no settings.json exists', () => {
      expect(isHooksInstalled(tmpdir)).toBe(false);
    });

    it('returns false when settings.json has no hooks', () => {
      const settingsDir = path.join(tmpdir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({})
      );
      expect(isHooksInstalled(tmpdir)).toBe(false);
    });

    it('returns true after installing hooks', () => {
      installHooks(tmpdir);
      expect(isHooksInstalled(tmpdir)).toBe(true);
    });

    it('returns false after uninstalling hooks', () => {
      installHooks(tmpdir);
      uninstallHooks(tmpdir);
      expect(isHooksInstalled(tmpdir)).toBe(false);
    });

    it('returns true for custom port after installing with same port', () => {
      installHooks(tmpdir, 5555);
      expect(isHooksInstalled(tmpdir, 5555)).toBe(true);
    });

    it('returns false when checking with wrong port', () => {
      installHooks(tmpdir, 5555);
      expect(isHooksInstalled(tmpdir, 9876)).toBe(false);
    });

    it('returns false when Stop hook type is missing', () => {
      const settingsDir = path.join(tmpdir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: '', command: 'curl http://127.0.0.1:9876/hook' }],
            PostToolUse: [{ matcher: '', command: 'curl http://127.0.0.1:9876/hook' }],
            Notification: [{ matcher: '', command: 'curl http://127.0.0.1:9876/hook' }],
          },
        })
      );
      expect(isHooksInstalled(tmpdir)).toBe(false);
    });

    it('returns false when hook type is missing', () => {
      const settingsDir = path.join(tmpdir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: '', command: 'curl http://127.0.0.1:9876/hook' }],
          },
        })
      );
      expect(isHooksInstalled(tmpdir)).toBe(false);
    });
  });
});
