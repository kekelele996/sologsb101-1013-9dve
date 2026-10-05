/** 珊瑚形态 */
export type CoralForm = '枝状' | '块状' | '叶状' | '软珊瑚'

export const CORAL_FORMS: CoralForm[] = ['枝状', '块状', '叶状', '软珊瑚']

/** 白化等级 */
export type BleachLevel = '无' | '轻' | '中' | '重' | '死亡'

export const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/** 珊瑚记录的下水复查（每条记录最多补记一次，可修改覆盖） */
export interface CoralReview {
  /** 复查日期（YYYY-MM-DD），不得早于样带调查日期 */
  reviewDate: string
  /** 复查覆盖长度（cm），超出样带全长时按样带全长记 */
  coverCm: number
  /** 复查白化等级 */
  bleachLevel: BleachLevel
  /** 补记时间戳 */
  reviewedAt: number
}

/** 复查表单草稿（不存时间戳，保存时生成） */
export interface CoralReviewDraft {
  reviewDate: string
  coverCm: number
  bleachLevel: BleachLevel
}

/** 珊瑚记录：样带内某属名、某形态的覆盖长度与白化等级 */
export interface CoralRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名，如 鹿角珊瑚属 */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** 白化等级 */
  bleachLevel: BleachLevel
  /** 备注（病敌害、断枝等） */
  remark: string
  /** 下水复查：补记后覆盖率、白化指数与白化占比一律以复查值为准 */
  review?: CoralReview | null
  createdAt: number
  updatedAt: number
}

/** 是否已补记复查 */
export function hasCoralReview(record: Pick<CoralRecord, 'review'> | null | undefined): boolean {
  return Boolean(record?.review)
}

/** 生效覆盖长度：有复查取复查值，否则取初次录入值 */
export function effectiveCoverCm(record: Pick<CoralRecord, 'coverCm' | 'review'>): number {
  return record.review ? record.review.coverCm : record.coverCm
}

/** 生效白化等级：有复查取复查值，否则取初次录入值 */
export function effectiveBleachLevel(record: Pick<CoralRecord, 'bleachLevel' | 'review'>): BleachLevel {
  return record.review ? record.review.bleachLevel : record.bleachLevel
}

/**
 * 记录的生效覆盖长度 / 白化等级视图。
 * 所有覆盖率、白化指数、白化占比与等级分布统计都应先经此映射，
 * 保证补记复查后汇总口径不再使用初次录入值。
 */
export function effectiveCoral<T extends Pick<CoralRecord, 'coverCm' | 'bleachLevel' | 'review'>>(
  record: T
): T & { coverCm: number; bleachLevel: BleachLevel } {
  return record.review
    ? { ...record, coverCm: record.review.coverCm, bleachLevel: record.review.bleachLevel }
    : record
}

/** 珊瑚记录草稿（存于 surveyStore） */
export interface CoralDraft {
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  remark: string
}

export function createEmptyCoralDraft(): CoralDraft {
  return {
    genus: '',
    form: '枝状',
    coverCm: 100,
    bleachLevel: '无',
    remark: ''
  }
}

/** 常见属名（表单联想用） */
export const COMMON_GENERA: string[] = [
  '鹿角珊瑚属',
  '杯形珊瑚属',
  '滨珊瑚属',
  '蜂巢珊瑚属',
  '蔷薇珊瑚属',
  '陀螺珊瑚属',
  '石芝珊瑚属',
  '软珊瑚属',
  '柳珊瑚属',
  '星珊瑚属'
]

/** 批量粘贴解析出的一行珊瑚记录 */
export interface CoralPasteRow {
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
}

/**
 * 解析批量粘贴文本：每行「属名,形态,覆盖长度[,白化等级]」。
 * 逗号 / 制表符 / 分号可作分隔（属名常含空格，不用空格定界）。
 */
export function parseCoralPaste(text: string): { rows: CoralPasteRow[]; errors: string[] } {
  const rows: CoralPasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「属名,形态,覆盖长度(cm)」三列`)
      return
    }
    const form = cells[1] as CoralForm
    if (!CORAL_FORMS.includes(form)) {
      errors.push(`第 ${index + 1} 行形态「${cells[1]}」不在 ${CORAL_FORMS.join(' / ')} 之内`)
      return
    }
    const coverCm = Number(cells[2])
    if (!Number.isFinite(coverCm) || coverCm < 0) {
      errors.push(`第 ${index + 1} 行覆盖长度应为非负数字（cm）`)
      return
    }
    const bleachLevel = (cells.length >= 4 ? cells[3] : '无') as BleachLevel
    if (!BLEACH_LEVELS.includes(bleachLevel)) {
      errors.push(`第 ${index + 1} 行白化等级「${cells[3]}」不在 ${BLEACH_LEVELS.join(' / ')} 之内`)
      return
    }
    rows.push({
      genus: cells[0],
      form,
      coverCm: Number(coverCm.toFixed(1)),
      bleachLevel
    })
  })
  return { rows, errors }
}
