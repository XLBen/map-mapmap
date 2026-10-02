import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SemanticRegistry } from '../src/registry';

describe('通用性门槛（charter「工作方式」9）：设计时未知的语义零核心改动即用', () => {
  const registry = new SemanticRegistry();

  test('注册即可创建/sample/query/统计（field 族）', () => {
    registry.register({
      semantic: 'radiation',
      dataType: { family: 'field', field: 'scalar' },
      capabilities: ['sample', 'query'],
    });
    const radiation = registry.createField('radiation', {
      width: 16,
      height: 16,
      origin: { x: 0, y: 0 },
      resolution: 1,
      fill: (p) => Math.sin(p.x) + Math.cos(p.y),
    });
    expect(radiation.def.semantic).toBe('radiation');
    expect(radiation.sample({ x: 0, y: 0 })).toBe(1); // sin(0)+cos(0)
    const s = radiation.query(radiation.bounds);
    if (s.kind !== 'scalar') return expect.fail('应为 scalar 统计');
    expect(s.count).toBe(256);
    expect(s.nodataCount).toBe(0);
    expect(s.min).toBeGreaterThanOrEqual(-2);
    expect(s.max).toBeLessThanOrEqual(2);
    expect(registry.hasCapabilities('radiation', ['sample', 'query'])).toBe(true);
    expect(registry.hasCapabilities('radiation', ['render'])).toBe(false);
  });

  test('注册即可创建/query（feature 族）', () => {
    registry.register({ semantic: 'sensor', dataType: { family: 'feature', feature: 'point' } });
    const sensors = registry.createFeatureSet('sensor');
    sensors.add({ kind: 'point', id: 's1', semantic: 'sensor', pos: { x: 5, y: 5 }, attributes: {} });
    sensors.add({ kind: 'point', id: 's2', semantic: 'sensor', pos: { x: 50, y: 50 }, attributes: {} });
    expect(sensors.size).toBe(2);
    expect(sensors.query({ minX: 0, minY: 0, maxX: 10, maxY: 10 }).map((f) => f.id)).toEqual(['s1']);
    expect(sensors.query({ minX: 100, minY: 100, maxX: 110, maxY: 110 })).toEqual([]);
    expect(() =>
      sensors.add({
        kind: 'point',
        id: 's3',
        semantic: 'other',
        pos: { x: 0, y: 0 },
        attributes: {},
      } as never),
    ).toThrow();
  });

  test('注册表守卫：重复注册 / 非法命名 / 族不匹配', () => {
    expect(() =>
      registry.register({ semantic: 'radiation', dataType: { family: 'field', field: 'scalar' } }),
    ).toThrow();
    expect(() =>
      registry.register({ semantic: 'Bad-Name', dataType: { family: 'field', field: 'scalar' } }),
    ).toThrow();
    expect(() => registry.createField('sensor', { width: 1, height: 1, origin: { x: 0, y: 0 }, resolution: 1, fill: () => 0 })).toThrow();
    expect(() => registry.createFeatureSet('radiation')).toThrow();
  });
});

describe('核心纯度（charter「工作方式」9）：核心源码零领域概念', () => {
  test('src/*.ts 不含具体领域名词硬编码', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const domainTerms = /river|biome|magic/i;
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.ts')) continue;
      const text = readFileSync(`${srcDir}/${f}`, 'utf8');
      expect(domainTerms.test(text), `${f} 出现领域概念硬编码`).toBe(false);
    }
  });
});
