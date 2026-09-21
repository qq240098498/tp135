const assert = require('assert');
const fs = require('fs');
const root = require('path').join(__dirname, '..');
const api = require(`${root}/server/api`);
const store = require(`${root}/server/store`);
const { runDraw } = require(`${root}/server/draw`);

// ---- 1. 分档与结构（8 队默认 2 组 → 4 档各 2 支）----
const p = api.previewDraw({});
assert.strictEqual(p.groupCount, 2);
assert.strictEqual(p.perGroup, 4);
assert.strictEqual(p.potCount, 4);
assert.strictEqual(p.pots.length, 4);
p.pots.forEach((pot) => assert.strictEqual(pot.teams.length, 2, '每档队数=组数'));
assert.deepStrictEqual(p.pots[0].teams.map((t) => t.seedRank), [1, 2]);
assert.deepStrictEqual(p.pots[3].teams.map((t) => t.seedRank), [7, 8]);
console.log('1. 分档 OK');

// ---- 2. 每组每档恰一支、人数相等、无同城 ----
const r = api.performDraw({ seed: 'Z-9' });
assert.strictEqual(r.complete, true);
assert.deepStrictEqual(r.groups.map((g) => g.teams.length), [4, 4]);
r.groups.forEach((g) => {
  assert.deepStrictEqual(g.teams.map((t) => t.potNo).sort((a, b) => a - b), [1, 2, 3, 4]);
  const cs = g.teams.map((t) => t.city);
  assert.strictEqual(new Set(cs).size, cs.length, '组内无同城');
});
assert.strictEqual(new Set(r.groups.flatMap((g) => g.teams.map((t) => t.teamId))).size, 8);
console.log('2. 每组人数相等、每档一支、无同城 OK');

// ---- 3. 落位表与分组一致 ----
assert.strictEqual(r.assignments.length, 8);
r.assignments.forEach((a) => {
  const g = r.groups.find((x) => x.groupNo === a.groupNo);
  assert.ok(g.teams.some((t) => t.teamId === a.teamId && t.potNo === a.potNo));
});
console.log('3. 落位表一致 OK');

// ---- 4. 同种子复现（分组 + 重试记录 + 落位）----
const a1 = api.performDraw({ seed: '复现-测试-777' });
const a2 = api.performDraw({ seed: '复现-测试-777' });
assert.strictEqual(JSON.stringify(a1.groups), JSON.stringify(a2.groups));
assert.strictEqual(JSON.stringify(a1.retries), JSON.stringify(a2.retries));
assert.strictEqual(JSON.stringify(a1.assignments), JSON.stringify(a2.assignments));
console.log('4. 同种子完全复现 OK，retries=', a1.retryCount);

// ---- 5. 异种子不同 ----
assert.notStrictEqual(
  JSON.stringify(api.performDraw({ seed: '111' }).groups),
  JSON.stringify(api.performDraw({ seed: '222' }).groups),
);
console.log('5. 异种子结果不同 OK');

// ---- 6/7. 校验 ----
assert.throws(() => api.performDraw({}), (e) => e.code === 'SEED_REQUIRED');
assert.throws(() => api.previewDraw({ groupCount: 99 }), (e) => e.code === 'GROUP_COUNT_INVALID');
assert.throws(() => api.performDraw({ seed: 'x', maxRetries: 0 }), (e) => e.code === 'MAX_RETRIES_INVALID');
console.log('6/7. 种子/组数/重试上限校验 OK');

// ---- 8. 9 队 2 组：1 支落不下，组内仍相等 ----
const mk = (id, rank, city) => ({ id: `t${id}`, name: `队${id}`, shortName: `T${id}`, city: city || `城${id}`, seedRank: rank, status: '参赛' });
const d9 = runDraw(Array.from({ length: 9 }, (_, i) => mk(i + 1, i + 1)), { seedText: 'q', groupCount: 2, maxRetries: 500 });
assert.strictEqual(d9.complete, true);
assert.deepStrictEqual(d9.groups.map((g) => g.teams.length), [4, 4]);
assert.strictEqual(d9.leftovers.length, 1);
assert.ok(d9.leftovers[0].reason.includes('凑不齐完整一档'));
console.log('8. 余数落不下并说明原因 OK');

// ---- 9. 同城 3 队 2 组：穷尽后说明、不死循环 ----
const dC = runDraw([mk(1, 1, '同'), mk(2, 2, '同'), mk(3, 3, '同'), mk(4, 4, '甲'), mk(5, 5, '乙'), mk(6, 6, '丙')], { seedText: 'q', groupCount: 2, maxRetries: 500 });
assert.strictEqual(dC.complete, false);
assert.ok(dC.message.length > 10);
assert.ok(dC.undrawable.length > 0);
console.log('9. 必然无解给出说明 OK');

// ---- 10. 退赛队经正规 save 后不参与抽签（回归 normalize 状态池缺陷）----
const backup = fs.readFileSync(store.DATA_FILE, 'utf8');
try {
  const data = store.load();
  data.teams[0].status = '退赛';
  store.save(data);
  const dW = api.performDraw({ seed: 'w-1' });
  assert.strictEqual(dW.activeCount, 7);
  assert.ok(dW.withdrawnTeams.some((t) => t.teamId === 'team-1001'));
  assert.ok(!dW.groups.some((g) => g.teams.some((t) => t.teamId === 'team-1001')));
  assert.strictEqual(dW.leftovers.length, 1, '7 队默认 2 组 → 每组 3，余 1');
  assert.deepStrictEqual(dW.groups.map((g) => g.teams.length), [3, 3]);
  console.log('10. 退赛队不参与、余下单独列出 OK');
} finally {
  fs.writeFileSync(store.DATA_FILE, backup);
}

console.log('\n全部断言通过');
