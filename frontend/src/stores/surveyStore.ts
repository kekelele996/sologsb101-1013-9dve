/**
 * 普查 store：维护珊瑚与鱼类筛选条件、录入草稿与覆盖度派生值。
 * 覆盖 /belts/:id/corals、/belts/:id/fishes 与 /coverage 三页。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import {
  BLEACH_LEVELS,
  effectiveBleachLevel,
  effectiveCoral,
  effectiveCoverCm
} from '@/types/coralRecord'
import type { BleachLevel, CoralForm, CoralRecord, CoralReview } from '@/types/coralRecord'
import type { CountCategory, FishCount, SizeClass } from '@/types/fishCount'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 覆盖度汇总页筛选条件 */
export interface SurveyFilterState {
  keyword: string
  reefIds: string[]
  bleachLevels: BleachLevel[]
  /** 是否只看白化指数高于阈值的样带 */
  onlyBleached: boolean
}

export function createEmptySurveyFilter(): SurveyFilterState {
  return {
    keyword: '',
    reefIds: [],
    bleachLevels: [],
    onlyBleached: false
  }
}

/** 下水复查表单结果（页面校验日期后传入；覆盖长度仍在 store 内按样带全长封顶） */
export interface CoralReviewInput {
  reviewDate: string
  coverCm: number
  bleachLevel: BleachLevel
}

/** 覆盖度汇总行 */
export interface CoverageSummaryRow {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  /** 已补记下水复查的记录条数 */
  reviewedCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

export const useSurveyStore = defineStore('survey', () => {
  const corals = ref<CoralRecord[]>([])
  const fishes = ref<FishCount[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<SurveyFilterState>(createEmptySurveyFilter())
  /** 珊瑚录入草稿（跨页面保留） */
  const coralDraft = ref({
    genus: '',
    form: '枝状' as CoralForm,
    coverCm: 100,
    bleachLevel: '无' as BleachLevel,
    remark: ''
  })
  /** 鱼类计数草稿 */
  const fishDraft = ref({
    family: '',
    count: 1,
    sizeClass: '11-20cm' as SizeClass,
    category: '鱼类' as CountCategory
  })

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<CoralRecord>(() => db.corals).subscribe((rows) => {
      corals.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 某样带的珊瑚记录（按生效白化等级降序、生效覆盖长度降序；补记复查后以复查值为准） */
  function coralsOfBelt(beltId: string | null | undefined): CoralRecord[] {
    if (!beltId) return []
    const order: Record<BleachLevel, number> = { 无: 0, 轻: 1, 中: 2, 重: 3, 死亡: 4 }
    return corals.value
      .filter((coral) => coral.beltId === beltId)
      .sort((a, b) => {
        const diff = order[effectiveBleachLevel(b)] - order[effectiveBleachLevel(a)]
        if (diff !== 0) return diff
        return effectiveCoverCm(b) - effectiveCoverCm(a)
      })
  }

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 样带 id → 珊瑚记录数 / 鱼类记录数（样带列表回显用） */
  const beltRecordCounts = computed<Record<string, { coralCount: number; fishCount: number }>>(() => {
    const counts: Record<string, { coralCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      counts[belt.id] = {
        coralCount: corals.value.filter((coral) => coral.beltId === belt.id).length,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /** 覆盖度汇总行（全部样带） */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltCorals = corals.value.filter((coral) => coral.beltId === belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        // 统计一律用生效值：补记复查的记录按复查覆盖长度 / 等级参与汇总
        const metrics = beltCorals.map(effectiveCoral)
        const reviewedCount = beltCorals.filter((coral) => coral.review).length
        const coverCmTotal = round(
          metrics.reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        BLEACH_LEVELS.forEach((level) => {
          distribution[level] = round(
            metrics.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
            1
          )
        })
        const index = bleachIndex(beltCorals)
        const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
        return {
          beltId: belt.id,
          beltNo: belt.no,
          reefId: reef?.id ?? '',
          reefName: reef?.name ?? '未知礁区',
          siteId: site?.id ?? '',
          siteNo: site?.no ?? '—',
          lengthM: belt.lengthM,
          orientation: belt.orientation,
          surveyDate: belt.surveyDate,
          observer: belt.observer,
          coralCount: beltCorals.length,
          reviewedCount,
          coverCmTotal,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          bleachIndex: index,
          grade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(beltCorals),
          distribution,
          fishTotal,
          invertebrateTotal: beltFishes
            .filter((fish) => fish.category === '无脊椎动物')
            .reduce((sum, fish) => sum + fish.count, 0),
          fishDensity: fishDensity(fishTotal, belt.lengthM)
        }
      })
      .sort((a, b) => b.bleachIndex - a.bleachIndex)
  )

  /** 按筛选条件过滤后的覆盖度行 */
  const filteredCoverageRows = computed<CoverageSummaryRow[]>(() =>
    coverageRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.reefIds.length > 0 && !filter.value.reefIds.includes(row.reefId)) return false
      if (filter.value.bleachLevels.length > 0) {
        const matched = filter.value.bleachLevels.some((level) => row.distribution[level] > 0)
        if (!matched) return false
      }
      if (filter.value.onlyBleached && row.bleachedSharePct <= 0) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.reefIds.length > 0 ||
      filter.value.bleachLevels.length > 0 ||
      filter.value.onlyBleached
  )

  /** 全局白化等级分布与总体指数（均按复查生效值） */
  const globalStats = computed(() => {
    const metrics = corals.value.map(effectiveCoral)
    const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        metrics.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
    })
    const index = bleachIndex(corals.value)
    return {
      coralCount: corals.value.length,
      reviewedCount: corals.value.filter((coral) => coral.review).length,
      fishCount: fishes.value.length,
      coverCmTotal: round(
        metrics.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(corals.value),
      distribution
    }
  })

  function patchFilter(patch: Partial<SurveyFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySurveyFilter()
  }

  function patchCoralDraft(patch: Partial<typeof coralDraft.value>): void {
    coralDraft.value = { ...coralDraft.value, ...patch }
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
  }

  /* ------------------------------ 珊瑚记录 ------------------------------ */

  async function createCoral(
    beltId: string,
    payload: Omit<CoralRecord, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<CoralRecord> {
    const now = Date.now()
    const row: CoralRecord = { ...payload, beltId, id: createId('cor'), createdAt: now, updatedAt: now }
    await db.corals.put(row)
    return row
  }

  async function updateCoral(id: string, patch: Partial<CoralRecord>): Promise<void> {
    await db.corals.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCoral(id: string): Promise<void> {
    await db.corals.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有珊瑚记录） */
  async function importCoralRows(
    beltId: string,
    rows: Array<{ genus: string; form: CoralForm; coverCm: number; bleachLevel: BleachLevel }>
  ): Promise<number> {
    const now = Date.now()
    const records: CoralRecord[] = rows.map((row, index) => ({
      id: createId('cor'),
      beltId,
      genus: row.genus,
      form: row.form,
      coverCm: row.coverCm,
      bleachLevel: row.bleachLevel,
      remark: '',
      review: null,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.corals], async () => {
      await db.corals.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.corals.bulkPut(records)
    })
    return records.length
  }

  /** 批量改写白化等级（改的是初查等级；已补记复查的记录统计仍以复查值为准） */
  async function bulkSetBleachLevel(ids: string[], bleachLevel: BleachLevel): Promise<number> {
    const now = Date.now()
    await db.corals
      .where('id')
      .anyOf(ids)
      .modify((coral) => {
        coral.bleachLevel = bleachLevel
        coral.updatedAt = now
      })
    return ids.length
  }

  /* ------------------------------ 下水复查 ------------------------------ */

  /**
   * 补记/修改一次下水复查。每条记录至多一条复查，重复调用即覆盖。
   * 复查长度超出样带全长时按样带全长记；返回最终落库的复查对象。
   */
  async function saveCoralReview(recordId: string, input: CoralReviewInput): Promise<CoralReview | null> {
    const record = corals.value.find((coral) => coral.id === recordId)
    if (!record) return null
    const belt = belts.value.find((item) => item.id === record.beltId)
    const beltLengthCm = belt ? belt.lengthM * 100 : Infinity
    const coverCm = Number(
      Math.max(0, Math.min(input.coverCm, beltLengthCm)).toFixed(1)
    )
    const review: CoralReview = {
      reviewDate: input.reviewDate,
      coverCm,
      bleachLevel: input.bleachLevel,
      reviewedAt: record.review?.reviewedAt ?? Date.now()
    }
    await db.corals.update(recordId, { review, updatedAt: Date.now() } as never)
    return review
  }

  /** 撤销复查：恢复为按初查覆盖长度与白化等级统计 */
  async function clearCoralReview(recordId: string): Promise<void> {
    await db.corals.update(recordId, { review: null, updatedAt: Date.now() } as never)
  }

  /** 校验复查日期不得早于样带调查日期；样带不存在时跳过日期限制 */
  function isReviewDateValid(beltId: string, reviewDate: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) return false
    const belt = belts.value.find((item) => item.id === beltId)
    if (!belt) return true
    return reviewDate >= belt.surveyDate
  }

  /* ------------------------------ 鱼类计数 ------------------------------ */

  async function createFish(
    beltId: string,
    payload: Omit<FishCount, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<FishCount> {
    const now = Date.now()
    const row: FishCount = { ...payload, beltId, id: createId('fsh'), createdAt: now, updatedAt: now }
    await db.fishes.put(row)
    return row
  }

  async function updateFish(id: string, patch: Partial<FishCount>): Promise<void> {
    await db.fishes.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeFish(id: string): Promise<void> {
    await db.fishes.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有计数） */
  async function importFishRows(
    beltId: string,
    rows: Array<{ family: string; count: number; sizeClass: SizeClass; category: CountCategory }>
  ): Promise<number> {
    const now = Date.now()
    const records: FishCount[] = rows.map((row, index) => ({
      id: createId('fsh'),
      beltId,
      family: row.family,
      count: row.count,
      sizeClass: row.sizeClass,
      category: row.category,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.fishes], async () => {
      await db.fishes.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fishes.bulkPut(records)
    })
    return records.length
  }

  /** 按科名与体长段汇总某样带计数 */
  function fishSummaryOfBelt(beltId: string | null | undefined): Array<{
    family: string
    category: CountCategory
    total: number
    bySize: Record<SizeClass, number>
  }> {
    if (!beltId) return []
    const map = new Map<string, { family: string; category: CountCategory; total: number; bySize: Record<SizeClass, number> }>()
    fishesOfBelt(beltId).forEach((fish) => {
      const bucket =
        map.get(fish.family) ??
        { family: fish.family, category: fish.category, total: 0, bySize: { '0-10cm': 0, '11-20cm': 0, '21-30cm': 0, '>30cm': 0 } }
      bucket.total += fish.count
      bucket.bySize[fish.sizeClass] += fish.count
      map.set(fish.family, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }

  return {
    corals,
    fishes,
    reefs,
    sites,
    belts,
    ready,
    error,
    filter,
    coralDraft,
    fishDraft,
    beltRecordCounts,
    coverageRows,
    filteredCoverageRows,
    hasFilter,
    globalStats,
    start,
    coralsOfBelt,
    fishesOfBelt,
    fishSummaryOfBelt,
    patchFilter,
    resetFilter,
    patchCoralDraft,
    patchFishDraft,
    createCoral,
    updateCoral,
    removeCoral,
    importCoralRows,
    bulkSetBleachLevel,
    saveCoralReview,
    clearCoralReview,
    isReviewDateValid,
    createFish,
    updateFish,
    removeFish,
    importFishRows
  }
})
