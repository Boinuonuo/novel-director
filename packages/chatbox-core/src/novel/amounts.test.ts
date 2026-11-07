import { describe, expect, it } from 'vitest'
import { collectExchangeRates, settleAmount } from './amounts'

const rates = collectExchangeRates(['1银=100铜', '一金＝十银', '通铺一晚十二铜'])

describe('settleAmount', () => {
  it('corrects a wrong sum in one unit', () => {
    expect(settleAmount('37铜', '-12铜', '26铜')).toBe('25铜')
  })

  it('reads Chinese numerals, and keeps a right answer as the model wrote it', () => {
    expect(settleAmount('三十七枚铜币', '-十二枚铜币', '25枚铜币')).toBe('25枚铜币')
    expect(settleAmount('一百零五枚铜币', '+三枚铜币', '100枚铜币')).toBe('108枚铜币')
  })

  it('works across denominations with a rate the story stated', () => {
    expect(settleAmount('8银9铜', '-12铜', '7银95铜', rates)).toBe('7银97铜')
    expect(settleAmount('1金2银', '-30铜', '错', rates)).toBe('1金1银70铜')
  })

  it('trusts the model when no rate links the units', () => {
    expect(settleAmount('8银9铜', '-12铜', '7银97铜')).toBe('7银97铜')
  })

  it('leaves what is not an amount alone', () => {
    expect(settleAmount('C级冒险者', '+1', 'B级冒险者')).toBe('B级冒险者')
    expect(settleAmount('三两银子', '-一两银子', '二两银子')).toBe('二两银子')
    expect(settleAmount('37铜', '花了一些', '30铜')).toBe('30铜')
  })

  it('needs a signed change and a value to start from', () => {
    expect(settleAmount('37铜', '12铜', '25铜')).toBe('25铜')
    expect(settleAmount(undefined, '-12铜', '25铜')).toBe('25铜')
  })

  it('does not write a negative balance', () => {
    expect(settleAmount('5铜', '-12铜', '还欠七铜')).toBe('还欠七铜')
  })
})

describe('collectExchangeRates', () => {
  it('reads rates and skips everything else', () => {
    expect([...rates.keys()]).toEqual(['银', '金'])
    expect(rates.get('金')).toEqual({ unit: '银', factor: 10 })
  })
})
