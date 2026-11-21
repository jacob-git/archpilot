import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

interface VsCodePackageJson {
  contributes: {
    menus: Record<string, MenuEntry[]>;
  };
}

test('VS Code sidebar project menu and File Explorer ArchPilot submenu stay in sync', async () => {
  const pkgPath = path.resolve(process.cwd(), '..', 'vscode', 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as VsCodePackageJson;
  const menus = pkg.contributes.menus;

  const sidebarProjectItems = (menus['view/item/context'] ?? [])
    .filter((entry) => entry.when?.includes('archpilot\\.project'))
    .map((entry) => ({
      id: entry.command ?? entry.submenu,
      group: entry.group,
    }));

  const explorerItems = (menus['archpilot.explorerMenu'] ?? []).map((entry) => ({
    id: entry.command ?? entry.submenu,
    group: entry.group,
  }));

  assert.deepEqual(
    explorerItems,
    sidebarProjectItems,
    'archpilot.explorerMenu must match view/item/context project entries and group ordering'
  );

  // Ensure every shared submenu referenced by both menus allows File Explorer visibility
  const sharedSubmenus = explorerItems
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id && menus[id]));

  assert.ok(sharedSubmenus.length > 0, 'Expected at least one shared submenu');

  for (const submenuId of sharedSubmenus) {
    const entries = menus[submenuId] ?? [];
    assert.ok(entries.length > 0, `Shared submenu "${submenuId}" must not be empty`);
    for (const entry of entries) {
      if (entry.when) {
        assert.ok(
          entry.when.includes('explorerResourceIsRoot'),
          `Menu entry "${entry.command ?? entry.submenu}" in "${submenuId}" must include "explorerResourceIsRoot" in its "when" clause`
        );
      }
    }
  }
});
