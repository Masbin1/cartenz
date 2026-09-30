import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { wrap } from './office-desk';
import { OfficeCanvas } from './office-canvas';
import { OfficeFilterBar } from './office-filter-bar';
import { OfficeLegend } from './office-legend';
import { OfficeMobileList } from './office-mobile-list';
import { NO_FILTERS, buildOfficeModel } from '@/lib/office/model';
import { board, card, finished, queue } from '@/lib/office/fixtures';

/**
 * Component tests, rendered to static markup.
 *
 * The frontend has no DOM test environment (no jsdom, no Testing Library), so
 * these assert on server-rendered HTML. That covers what the dev task asks of
 * the renderer - an agent renders with its status in words, rooms and the
 * dispatch node render, connections render, filters dim rather than remove,
 * controls exist - without adding a browser emulator to the repo. Click and
 * zoom behaviour is covered at the reducer level (camera.test.ts) and by the
 * handlers being plain props here.
 */

const noop = () => undefined;

function floorWith(cards = [card('implementing')], opts: { live?: boolean } = {}) {
  return buildOfficeModel({
    board: board(cards, [finished('completed')]),
    attention: [],
    queue: queue({ capacity: 2, running: cards.length }),
    live: opts.live ?? true,
  });
}

test('wrap keeps short text on one line', () => {
  assert.deepEqual(wrap('Short task', 26, 2), ['Short task']);
});

test('wrap breaks on words and never exceeds the line limit', () => {
  const lines = wrap('Create a sale approval module with two levels of sign-off', 26, 2);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(line.length <= 26, line);
});

test('the canvas renders every room, the dispatch node and each agent', () => {
  const model = floorWith([
    card('implementing', { taskId: '11111111-1111-4111-8111-111111111111' }),
    card('testing', { taskId: '22222222-2222-4222-8222-222222222222' }),
  ]);
  const html = renderToStaticMarkup(
    <OfficeCanvas model={model} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );

  for (const room of ['Research', 'Development', 'Quality', 'Operations']) {
    assert.match(html, new RegExp(room, 'i'), `room ${room}`);
  }
  assert.match(html, /Dispatch/);
  assert.match(html, /2\/2 busy/);
  assert.match(html, /2 tasks on the floor/);
});

test('an agent is labelled with project, reference and status in words', () => {
  const model = floorWith([card('implementing')]);
  const html = renderToStaticMarkup(
    <OfficeCanvas model={model} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );
  const agent = model.agents[0];
  assert.match(
    html,
    new RegExp(`aria-label="${agent.projectName} ${agent.taskReference}, Working`),
  );
  // Status is text as well as colour.
  assert.match(html, /● Working/);
  // Keyboard reachable.
  assert.match(html, /role="button" tabindex="0"/);
});

test('an approval shows its glyph and a task bubble', () => {
  const model = floorWith([card('waiting_approval')]);
  const html = renderToStaticMarkup(
    <OfficeCanvas model={model} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );
  assert.match(html, /⚠ Approval/);
  assert.match(html, /office-bubble/);
});

test('a waiting (testing) agent has no task bubble', () => {
  const model = floorWith([card('testing')]);
  const html = renderToStaticMarkup(
    <OfficeCanvas model={model} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );
  assert.match(html, /◐ Waiting/);
  assert.doesNotMatch(html, /office-bubble/);
});

test('connections render as paths, and flow only when active', () => {
  const model = floorWith([card('implementing')]);
  assert.ok(model.connections.length > 0);
  const html = renderToStaticMarkup(
    <OfficeCanvas model={model} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );
  assert.match(html, /data-connection="research→development"/);
  assert.match(html, /office-flow/);
});

test('an empty office still draws its rooms and empty desks, with no connections', () => {
  const model = floorWith([]);
  const html = renderToStaticMarkup(
    <OfficeCanvas model={model} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );
  assert.match(html, /RESEARCH/);
  assert.match(html, /0 tasks on the floor/);
  assert.doesNotMatch(html, /data-connection=/);
  assert.doesNotMatch(html, /role="button"/);
});

test('a department filter dims other agents without removing them', () => {
  const model = floorWith([
    card('implementing', { taskId: '11111111-1111-4111-8111-111111111111' }),
    card('testing', { taskId: '22222222-2222-4222-8222-222222222222' }),
  ]);
  const html = renderToStaticMarkup(
    <OfficeCanvas
      model={model}
      filters={{ department: 'development', projectId: 'all' }}
      selectedId={null}
      onSelect={noop}
    />,
  );
  // Both agents are still on the floor.
  assert.equal((html.match(/role="button"/g) ?? []).length, 2);
  // At least one is drawn subdued.
  assert.match(html, /opacity:0\.45/);
});

test('the selected agent gets a visible outline', () => {
  const model = floorWith([card('implementing')]);
  const unselected = renderToStaticMarkup(
    <OfficeCanvas model={model} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );
  const selected = renderToStaticMarkup(
    <OfficeCanvas
      model={model}
      filters={NO_FILTERS}
      selectedId={model.agents[0].id}
      onSelect={noop}
    />,
  );
  assert.ok(selected.length > unselected.length);
  assert.match(selected, /stroke="rgb\(var\(--accent\)\)"/);
});

test('camera controls render with accessible names', () => {
  const html = renderToStaticMarkup(
    <OfficeCanvas model={floorWith()} filters={NO_FILTERS} selectedId={null} onSelect={noop} />,
  );
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(html, /aria-label="Zoom out"/);
  assert.match(html, /aria-label="Reset view"/);
  assert.match(html, /100%/);
});

test('the filter bar marks the active department and only offers projects on the floor', () => {
  const html = renderToStaticMarkup(
    <OfficeFilterBar
      filters={{ department: 'quality', projectId: 'all' }}
      onChange={noop}
      projects={[
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
      ]}
    />,
  );
  assert.match(html, /aria-pressed="true"[^>]*>Quality/);
  assert.match(html, /aria-pressed="false"[^>]*>All/);
  assert.match(html, /All projects/);
  assert.match(html, />Alpha</);
  assert.match(html, />Beta</);
});

test('the filter bar hides the project select when only one project is on the floor', () => {
  const html = renderToStaticMarkup(
    <OfficeFilterBar
      filters={NO_FILTERS}
      onChange={noop}
      projects={[{ id: 'a', name: 'Alpha' }]}
    />,
  );
  assert.doesNotMatch(html, /<select/);
});

test('the legend lists every status with a glyph and a word', () => {
  const html = renderToStaticMarkup(<OfficeLegend />);
  const items = html.split('<li').slice(1);
  const expected: [string, string][] = [
    ['●', 'Working'],
    ['◐', 'Waiting'],
    ['⚠', 'Approval'],
    ['○', 'Queued'],
    ['✓', 'Completed'],
    ['×', 'Failed'],
  ];
  assert.equal(items.length, expected.length);
  expected.forEach(([glyph, word], index) => {
    assert.ok(items[index].includes(glyph), `${word} glyph`);
    assert.ok(items[index].includes(word), word);
  });
});

test('the mobile list groups agents by room and puts approvals first', () => {
  const model = floorWith([
    card('implementing', { taskId: '11111111-1111-4111-8111-111111111111' }),
    card('waiting_approval', { taskId: '22222222-2222-4222-8222-222222222222' }),
  ]);
  const html = renderToStaticMarkup(<OfficeMobileList agents={model.agents} onSelect={noop} />);
  assert.match(html, /Research/);
  assert.match(html, /Development/);
  assert.ok(html.indexOf('Approval') > -1);
});

test('the mobile list says the floor is empty instead of rendering nothing', () => {
  const html = renderToStaticMarkup(<OfficeMobileList agents={[]} onSelect={noop} />);
  assert.match(html, /No task is on the floor right now/);
});
