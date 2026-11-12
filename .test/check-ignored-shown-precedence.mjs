#!/usr/bin/env node
/**
 * 手动「显示」的供给不能被整类忽略冲掉 —— 用户口径（2026-11-12）。
 *
 * 用户原话：
 *   「哪怕我忽略了 Opus 整个模型，但是我手动放出来那一个站，那一个站应该是可以用的呀。」
 *
 * 这是一个**存储层**的 bug，不是判定层的：
 *   - ignoreChecker 的优先级本来就对（作用域 shown > 整类名单）；
 *   - 但 applyIgnoredModels 在写名单时会把新忽略那一类里遗留的 shown 例外删掉，
 *     于是用户的意图在落盘那一刻就丢了，界面上再也找不回来。
 *
 * 本测试盯的就是这条：写名单不得动 modelOverrides。
 */

import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const inv = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)

let pass = 0
const ok = (label, fn) => { fn(); pass += 1; console.log('  ✓ ' + label) }

const SCOPE_KEY = 'p_rapid::Rapid-Kiro::claude-opus-5-5'

console.log('[1] 写入整类忽略名单时，不得删除任何 modelOverrides')
{
  ok('先 shown 后整类忽略：shown 必须还在', () => {
    const db = {
      settings: {
        ignoredModels: [],
        modelOverrides: { [SCOPE_KEY]: 'shown' },
        modelAliases: {},
      },
    }
    inv.applyIgnoredModels(db, ['claude-opus-5.5'], { enforce: [] })
    assert.deepEqual(db.settings.ignoredModels, ['claude-opus-5.5'], '名单要写进去')
    assert.deepEqual(db.settings.modelOverrides, { [SCOPE_KEY]: 'shown' }, 'shown 例外不能被删')
  })

  ok('重复忽略同一个模型（第二次写同一份名单）也不得删', () => {
    const db = {
      settings: {
        ignoredModels: ['claude-opus-5.5'],
        modelOverrides: { [SCOPE_KEY]: 'shown' },
        modelAliases: {},
      },
    }
    inv.applyIgnoredModels(db, ['claude-opus-5.5'], { enforce: [] })
    assert.deepEqual(db.settings.modelOverrides, { [SCOPE_KEY]: 'shown' })
  })

  ok('带 enforceIgnored 也不得删（旧实现会在这里清掉）', () => {
    const db = {
      settings: {
        ignoredModels: ['claude-opus-5.5'],
        modelOverrides: { [SCOPE_KEY]: 'shown' },
        modelAliases: {},
      },
    }
    inv.applyIgnoredModels(db, ['claude-opus-5.5'], { enforce: ['claude-opus-5.5'] })
    assert.deepEqual(db.settings.modelOverrides, { [SCOPE_KEY]: 'shown' })
  })

  ok('多个 shown 例外与多个忽略项互不干扰', () => {
    const db = {
      settings: {
        ignoredModels: [],
        modelOverrides: {
          [SCOPE_KEY]: 'shown',
          'p_x::别组::claude-opus-5-5': 'ignored',
          'p_y::另一组::gpt-6.1-sol': 'shown',
        },
        modelAliases: {},
      },
    }
    inv.applyIgnoredModels(db, ['claude-opus-5.5', 'gpt-6.1-sol'], { enforce: [] })
    assert.equal(Object.keys(db.settings.modelOverrides).length, 3, '三条例外都要保留')
  })
}

console.log('\n[2] 判定器在「整类忽略 + 单行 shown」时给出正确结论')
{
  ok('整类问 → 忽略；有 shown 的那一行 → 显示；其它组 → 忽略', () => {
    const db = {
      settings: {
        ignoredModels: ['claude-opus-5.5'],
        modelOverrides: { [SCOPE_KEY]: 'shown' },
        modelAliases: {},
      },
    }
    const check = inv.ignoreChecker(db)
    assert.equal(check('claude-opus-5.5'), true, '整类问应被忽略')
    assert.equal(check('claude-opus-5-5', { providerId: 'p_rapid', group: 'Rapid-Kiro' }), false, 'shown 那行应显示')
    assert.equal(check('claude-opus-5-5', { providerId: 'p_other', group: '别组' }), true, '别组应被忽略')
  })

  ok('单行 ignored 压过「不在整类名单」', () => {
    const db = {
      settings: {
        ignoredModels: [],
        modelOverrides: { 'p_1::g::m-a': 'ignored' },
        modelAliases: {},
      },
    }
    const check = inv.ignoreChecker(db)
    assert.equal(check('m-a', { providerId: 'p_1', group: 'g' }), true)
    assert.equal(check('m-a', { providerId: 'p_2', group: 'g' }), false)
  })
}

console.log('\n[3] 键写法容错：站上写作 5-5、请求里写作 5.5 也要认得出（2026-11-12 真实故障）')
{
  ok('override 键用连字符、判定用点号 → 仍然命中 shown', () => {
    const db = {
      settings: {
        ignoredModels: ['claude-opus-5.5'],
        modelOverrides: { 'p_rapid::Rapid-Kiro::claude-opus-5-5': 'shown' },
        modelAliases: {},
      },
    }
    const check = inv.ignoreChecker(db)
    assert.equal(check('claude-opus-5.5', { providerId: 'p_rapid', group: 'Rapid-Kiro' }), false,
      '请求里的 claude-opus-5.5 必须认出站点写法 claude-opus-5-5 的 shown')
    assert.equal(check('claude-opus-5-5', { providerId: 'p_rapid', group: 'Rapid-Kiro' }), false)
    assert.equal(check('claude-opus-5.5', { providerId: 'p_rapid', group: '别的组' }), true,
      '同一站别的分组仍应被整类忽略挡住')
    assert.equal(check('claude-opus-5.5', { providerId: 'p_other', group: 'Rapid-Kiro' }), true,
      '别的站的同名分组也仍应被挡住')
  })

  ok('单行 ignored 同样支持写法容错', () => {
    const db = {
      settings: {
        ignoredModels: [],
        modelOverrides: { 'p_1::g::m-2.0': 'ignored' },
        modelAliases: {},
      },
    }
    const check = inv.ignoreChecker(db)
    assert.equal(check('m-2-0', { providerId: 'p_1', group: 'g' }), true, '写法不同也要认得出这条 ignored')
  })

  ok('不同站/不同组的例外互不串味', () => {
    const db = {
      settings: {
        ignoredModels: ['m-a'],
        modelOverrides: {
          'p_1::g1::m-a': 'shown',
          'p_2::g2::m-a': 'ignored',
        },
        modelAliases: {},
      },
    }
    const check = inv.ignoreChecker(db)
    assert.equal(check('m-a', { providerId: 'p_1', group: 'g1' }), false, 'p_1/g1 是 shown')
    assert.equal(check('m-a', { providerId: 'p_2', group: 'g2' }), true, 'p_2/g2 是显式 ignored')
    assert.equal(check('m-a', { providerId: 'p_3', group: 'g3' }), true, '没例外的走整类名单')
  })
}

console.log('\n[4] routeableOffers：手动放出来的那一条真的进了在役集合')
{
  ok('整类忽略后，shown 的那条 supply 仍在 routeableOffers 里', () => {
    const db = {
      providers: [{ id: 'p_rapid', paused: false }],
      offers: [
        { id: 'o_kiro', providerId: 'p_rapid', credentialId: 'c1', group: 'Rapid-Kiro', upstreamName: 'claude-opus-5-5', modelKey: 'claude-opus-5-5' },
        { id: 'o_other', providerId: 'p_rapid', credentialId: 'c2', group: '别的组', upstreamName: 'claude-opus-5-5', modelKey: 'claude-opus-5-5' },
      ],
      settings: {
        ignoredModels: ['claude-opus-5.5'],
        modelOverrides: { 'p_rapid::Rapid-Kiro::claude-opus-5-5': 'shown' },
        modelAliases: {},
      },
    }
    const live = inv.routeableOffers(db).map((o) => o.id)
    assert.deepEqual(live, ['o_kiro'], '只有手动放出来的那一条能进在役集合，实际 ' + JSON.stringify(live))
  })
}

console.log(`\ncheck-ignored-shown-precedence: ${pass} 组断言通过`)
process.exit(0)
