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

    // Group entries by slot so mutually exclusive sidebar/explorer variants (e.g. Generate vs Update AGENTS.md) stay in sync
    const slots = new Map<string, MenuEntry[]>();
    for (const entry of entries) {
      const slotKey = entry.group ?? (entry.command ?? entry.submenu ?? 'default');
      const list = slots.get(slotKey) ?? [];
      list.push(entry);
      slots.set(slotKey, list);
    }

    for (const [slotKey, slotEntries] of slots.entries()) {
      const visibleInExplorer = slotEntries.some(
        (e) => !e.when || e.when.includes('explorerResourceIsRoot')
      );
      const visibleInSidebar = slotEntries.some(
        (e) => !e.when || e.when.includes('archpilot\\.project')
      );
      assert.ok(
        visibleInExplorer,
        `Slot "${slotKey}" in "${submenuId}" must have an entry visible in File Explorer (explorerResourceIsRoot)`
      );
      assert.ok(
        visibleInSidebar,
        `Slot "${slotKey}" in "${submenuId}" must have an entry visible in the ArchPilot sidebar`
      );
    }
  }
});
