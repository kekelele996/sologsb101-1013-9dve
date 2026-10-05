<script setup lang="ts">
/**
 * 模块 4：/belts/:id/corals 底质与珊瑚分类计数
 * 按属名与形态分组录入，同一样带叠加多条记录并汇总覆盖率与白化占比；
 * 支持批量粘贴与批量改白化等级，深链访问时样带不存在给出友好空态。
 * 复用 <BleachTag>、<StatBadge>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Edit, Plus, RefreshLeft } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import {
  BLEACH_LEVELS,
  COMMON_GENERA,
  CORAL_FORMS,
  effectiveBleachLevel,
  effectiveCoral,
  effectiveCoverCm,
  parseCoralPaste
} from '@/types/coralRecord'
import type { BleachLevel, CoralForm, CoralRecord } from '@/types/coralRecord'
import { BLEACH_BG, BLEACH_COLOR, bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, groupByForm, groupByGenus } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const beltId = computed(() => String(route.params.id ?? ''))
const belt = computed(() => beltStore.beltById(beltId.value))
const site = computed(() => (belt.value ? reefStore.siteById(belt.value.siteId) : null))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const selectedIds = ref<string[]>([])
const form = reactive({
  genus: '',
  form: '枝状' as CoralForm,
  coverCm: 100,
  bleachLevel: '无' as BleachLevel,
  remark: ''
})

const records = computed(() => surveyStore.coralsOfBelt(beltId.value))

/** 按属名分组汇总 */
const genusGroups = computed(() =>
  groupByGenus(records.value).map((group) => {
    const list = records.value.filter((record) => record.genus === group.genus)
    const index = bleachIndex(list)
    return { ...group, count: list.length, bleachIndex: index, grade: bleachGrade(index) }
  })
)

/** 按形态分组汇总 */
const formGroups = computed(() => groupByForm(records.value))

const stats = computed(() => {
  const list = records.value
  const metrics = list.map(effectiveCoral)
  const coverCmTotal = metrics.reduce((sum, record) => sum + record.coverCm, 0)
  const index = bleachIndex(list)
  return {
    coralCount: list.length,
    reviewedCount: list.filter((record) => record.review).length,
    coverCmTotal,
    coveragePct: belt.value ? coralCoveragePct(coverCmTotal, belt.value.lengthM) : 0,
    bleachIndex: index,
    grade: bleachGrade(index),
    bleachedSharePct: bleachedSharePct(list),
    maxCoverCm: metrics.length ? Math.max(...metrics.map((record) => record.coverCm)) : 0
  }
})

/** 白化等级 → 生效累计覆盖长度（有复查按复查等级/长度） */
const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = records.value
      .map(effectiveCoral)
      .filter((record) => record.bleachLevel === level)
      .reduce((sum, record) => sum + record.coverCm, 0)
  })
  return result
})

/** 进度条宽度（%），总量为 0 时返回 0% */
function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

function openCreate(): void {
  editingId.value = null
  form.genus = ''
  form.form = '枝状'
  form.coverCm = 100
  form.bleachLevel = '无'
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(record: CoralRecord): void {
  editingId.value = record.id
  form.genus = record.genus
  form.form = record.form
  form.coverCm = record.coverCm
  form.bleachLevel = record.bleachLevel
  form.remark = record.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.genus.trim()) {
    ElMessage.warning('请填写属名')
    return
  }
  if (!Number.isFinite(form.coverCm) || form.coverCm < 0) {
    ElMessage.warning('覆盖长度应为非负数字（cm）')
    return
  }
  if (belt.value && form.coverCm > belt.value.lengthM * 100) {
    ElMessage.warning(`覆盖长度不应超过样带长度（${belt.value.lengthM * 100} cm）`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      genus: form.genus.trim(),
      form: form.form,
      coverCm: form.coverCm,
      bleachLevel: form.bleachLevel,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await surveyStore.updateCoral(editingId.value, payload)
      ElMessage.success('珊瑚记录已更新')
    } else {
      await surveyStore.createCoral(beltId.value, payload)
      ElMessage.success('珊瑚记录已新增，覆盖率与白化占比已重算')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRecord(record: CoralRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${record.genus}（${record.form}）」覆盖 ${record.coverCm} cm 的记录？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.removeCoral(record.id)
  selectedIds.value = selectedIds.value.filter((id) => id !== record.id)
  ElMessage.success('珊瑚记录已删除')
}

function toggleSelect(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll(): void {
  selectedIds.value =
    selectedIds.value.length === records.value.length ? [] : records.value.map((record) => record.id)
}

async function bulkSetLevel(level: BleachLevel): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要批量改级的记录')
    return
  }
  const count = await surveyStore.bulkSetBleachLevel(selectedIds.value, level)
  ElMessage.success(`已批量将 ${count} 条记录的白化等级改为「${level}」`)
  selectedIds.value = []
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「属名,形态,覆盖长度[,白化等级]」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行数据覆盖该样带现有 ${records.value.length} 条珊瑚记录，确认导入？`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await surveyStore.importCoralRows(beltId.value, parsed.rows)
  pasteVisible.value = false
  ElMessage.success(`已导入 ${count} 条珊瑚记录`)
}

function gotoFishes(): void {
  void router.push(`/belts/${beltId.value}/fishes`)
}

/* ------------------------------ 下水复查 ------------------------------ */

const reviewVisible = ref(false)
const reviewSaving = ref(false)
const reviewRecordId = ref<string | null>(null)
const reviewClamped = ref(false)
const reviewForm = reactive({
  reviewDate: new Date().toISOString().slice(0, 10),
  coverCm: 100,
  bleachLevel: '无' as BleachLevel
})

const beltLengthCm = computed(() => (belt.value ? belt.value.lengthM * 100 : 0))

function openReview(record: CoralRecord): void {
  reviewRecordId.value = record.id
  reviewForm.reviewDate = record.review?.reviewDate ?? new Date().toISOString().slice(0, 10)
  reviewForm.coverCm = record.review?.coverCm ?? record.coverCm
  reviewForm.bleachLevel = record.review?.bleachLevel ?? record.bleachLevel
  reviewClamped.value = false
  reviewVisible.value = true
}

/** 复查长度超出样带全长时即时提示并按样带全长记 */
function clampReviewCover(): void {
  if (beltLengthCm.value > 0 && reviewForm.coverCm > beltLengthCm.value) {
    reviewForm.coverCm = beltLengthCm.value
    reviewClamped.value = true
  } else {
    reviewClamped.value = false
  }
}

async function submitReview(): Promise<void> {
  if (!reviewRecordId.value || !belt.value) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewForm.reviewDate)) {
    ElMessage.warning('请选择复查日期')
    return
  }
  if (!surveyStore.isReviewDateValid(belt.value.id, reviewForm.reviewDate)) {
    ElMessage.warning(`复查日期不应早于调查日期（${belt.value.surveyDate}）`)
    return
  }
  if (!Number.isFinite(reviewForm.coverCm) || reviewForm.coverCm < 0) {
    ElMessage.warning('复查覆盖长度应为非负数字（cm）')
    return
  }
  reviewSaving.value = true
  try {
    const saved = await surveyStore.saveCoralReview(reviewRecordId.value, {
      reviewDate: reviewForm.reviewDate,
      coverCm: reviewForm.coverCm,
      bleachLevel: reviewForm.bleachLevel
    })
    if (saved && saved.coverCm !== reviewForm.coverCm) {
      ElMessage.success(`复查已保存，覆盖长度 ${reviewForm.coverCm} cm 超出样带全长，已按 ${saved.coverCm} cm 记`)
    } else {
      ElMessage.success('复查已补记，覆盖率、白化指数与白化占比已按复查结果重算')
    }
    reviewVisible.value = false
  } finally {
    reviewSaving.value = false
  }
}

async function removeReview(record: CoralRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤销「${record.genus}（${record.form}）」${record.review?.reviewDate ?? ''} 的下水复查？撤销后统计恢复为初查值。`,
      '撤销复查确认',
      { type: 'warning', confirmButtonText: '撤销复查', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.clearCoralReview(record.id)
  ElMessage.success('复查已撤销，统计恢复为初查覆盖长度与白化等级')
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  if (belt.value) beltStore.selectBelt(belt.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!beltStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!belt"
      entity-label="样带"
      :missing-id="beltId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        beltStore.belts.slice(0, 3).map((item) => ({
          id: item.id,
          label: `样带 ${item.no} 的珊瑚记录`,
          path: `/belts/${item.id}/corals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item v-if="site" :to="{ path: `/sites/${site.id}/belts` }">站位 {{ site.no }} 样带</el-breadcrumb-item>
            <el-breadcrumb-item>珊瑚分类计数</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            样带 {{ belt.no }} · 底质与珊瑚分类计数
            <el-tag size="small" effect="plain">{{ belt.orientation }}向</el-tag>
            <el-tag size="small" type="info" effect="plain">长 {{ belt.lengthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ belt.surveyDate }}</el-tag>
          </h2>
          <p class="gb-hint">
            按属名与形态逐条录入覆盖长度与白化等级；覆盖率 = 覆盖长度合计 / 样带长度，白化指数按覆盖长度加权。每条记录可下水复查补记一次，补记后覆盖率、白化指数与白化占比一律以复查结果为准。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button @click="gotoFishes">鱼类计数 →</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增珊瑚记录</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="珊瑚记录" :value="stats.coralCount" suffix="条" icon="Histogram" />
        <StatBadge label="已复查" :value="stats.reviewedCount" suffix="条" tone="info" icon="View" />
        <StatBadge label="覆盖长度合计" :value="stats.coverCmTotal" suffix="cm" tone="info" icon="Odometer" />
        <StatBadge label="珊瑚覆盖率" :value="stats.coveragePct" suffix="%" :percent="Math.min(100, stats.coveragePct)" tone="success" icon="PieChart" />
        <StatBadge
          label="白化指数"
          :value="stats.bleachIndex"
          suffix="/ 4"
          :tone="stats.bleachIndex > 1 ? 'warning' : 'success'"
          :icon="stats.bleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
        />
        <StatBadge label="白化占比" :value="stats.bleachedSharePct" suffix="%" tone="warning" icon="TrendCharts" />
      </div>
      <p v-if="stats.reviewedCount > 0" class="gb-hint">
        当前有 {{ stats.reviewedCount }} 条记录已补记下水复查，上方覆盖率、白化指数、白化占比与下方分布均按复查结果统计。
      </p>

      <el-card v-if="records.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>汇总视图</h3>
          <div class="page__bulk">
            <span class="gb-hint">批量改白化等级（初查值；已复查记录的统计仍以复查为准）：</span>
            <el-button v-for="level in BLEACH_LEVELS" :key="level" size="small" @click="bulkSetLevel(level)">
              {{ level }}
            </el-button>
          </div>
        </div>
        <div class="page__grid">
          <div>
            <h4 class="page__sub">按属名分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in genusGroups" :key="group.genus" class="gb-bar">
                <span>{{ group.genus }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#0b5d5a', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">
                  {{ group.coverCm }} cm · {{ group.count }} 条
                  <BleachTag :level="group.grade" size="small" :plain="true" />
                </span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">按形态分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in formGroups" :key="group.form" class="gb-bar">
                <span>{{ group.form }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#3f9ec4', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm</span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">白化等级分布（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="level in BLEACH_LEVELS" :key="`bar-${level}`" class="gb-bar">
                <span>{{ level }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ distribution[level] }} cm</span>
              </div>
            </div>
          </div>
        </div>
      </el-card>

      <EmptyPanel
        v-if="records.length === 0"
        title="该样带还没有珊瑚记录"
        description="按属名与形态逐条录入覆盖长度与白化等级；也可以批量粘贴导入整段摸底数据。"
        action-text="新增珊瑚记录"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <el-table v-else :data="records" border stripe class="gb-table-compact">
        <el-table-column label="选择" width="70" align="center">
          <template #default="{ row }">
            <el-checkbox :model-value="selectedIds.includes(row.id)" @change="() => toggleSelect(row.id)" />
          </template>
        </el-table-column>
        <el-table-column prop="genus" label="属名" min-width="140" />
        <el-table-column prop="form" label="形态" width="100" />
        <el-table-column label="覆盖长度 (cm)" width="190" align="right">
          <template #default="{ row }">
            <span class="gb-mono" :class="{ 'gb-value-reviewed': row.review }">{{ effectiveCoverCm(row) }}</span>
            <el-tag v-if="row.review" size="small" type="success" effect="plain" class="page__review-tag">复查</el-tag>
            <div class="gb-hint gb-mono">
              占样带 {{ belt.lengthM > 0 ? ((effectiveCoverCm(row) / (belt.lengthM * 100)) * 100).toFixed(1) : '0.0' }}%
            </div>
            <div v-if="row.review" class="gb-hint gb-mono gb-strike">初查 {{ row.coverCm }} cm</div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级" width="190">
          <template #default="{ row }">
            <BleachTag :level="effectiveBleachLevel(row)" size="small" :plain="true" />
            <div v-if="row.review" class="gb-hint">
              初查
              <BleachTag :level="row.bleachLevel" size="small" :plain="true" :icon="false" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="下水复查" width="150">
          <template #default="{ row }">
            <template v-if="row.review">
              <div class="gb-mono">{{ row.review.reviewDate }}</div>
              <el-button size="small" text type="primary" @click="openReview(row)">修改复查</el-button>
              <el-button size="small" text type="danger" @click="removeReview(row)">撤销</el-button>
            </template>
            <el-button v-else size="small" type="success" plain :icon="RefreshLeft" @click="openReview(row)">补记复查</el-button>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRecord(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无珊瑚记录" description="点击右上角「新增珊瑚记录」开始录入。" compact />
        </template>
      </el-table>

      <p v-if="records.length > 0" class="gb-hint">
          <el-button size="small" text type="primary" @click="toggleSelectAll">
            {selectedIds.length === records.length ? '取消全选' : '全选本页'}
          </el-button>
        已选 {{ selectedIds.length }} 条；最大单条覆盖长度 {{ stats.maxCoverCm }} cm。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑珊瑚记录' : '新增珊瑚记录'" width="540px" :close-on-click-modal="false">
      <el-alert
        v-if="editingId && records.find((item) => item.id === editingId)?.review"
        type="warning"
        :closable="false"
        show-icon
        title="该记录已补记下水复查，此处修改的是初查值；覆盖率、白化指数与白化占比仍以复查结果为准，如需变更请到表格中「修改复查」。"
        class="page__review-alert"
      />
      <el-form label-width="110px">
        <el-form-item label="属名" required>
          <el-input v-model="form.genus" list="genus-options" placeholder="如：鹿角珊瑚属" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="形态" required>
          <el-radio-group v-model="form.form">
            <el-radio-button v-for="item in CORAL_FORMS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="覆盖长度" required>
          <el-input-number v-model="form.coverCm" :min="0" :max="belt ? belt.lengthM * 100 : 10000" :step="10" controls-position="right" />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm）</span>
        </el-form-item>
        <el-form-item label="白化等级" required>
          <el-radio-group v-model="form.bleachLevel">
            <el-radio-button v-for="level in BLEACH_LEVELS" :key="level" :value="level">
              {{ level }}
            </el-radio-button>
          </el-radio-group>
          <div class="page__legend">
            <span
              v-for="level in BLEACH_LEVELS"
              :key="`legend-${level}`"
              class="page__legend-item"
              :style="{ background: BLEACH_BG[level], color: BLEACH_COLOR[level], borderColor: BLEACH_COLOR[level] }"
            >
              {{ level }}
            </span>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="如：局部褪色 / 台风扰动后白化" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增记录' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入珊瑚记录" width="620px">
      <p class="gb-hint">
        每行一条，格式「属名,形态,覆盖长度(cm)[,白化等级]」，逗号 / 制表符 / 分号均可。示例：<br />
        <span class="gb-mono">鹿角珊瑚属,枝状,860,无</span><br />
        <span class="gb-mono">蔷薇珊瑚属;叶状;720;中</span><br />
        <span class="gb-mono">滨珊瑚属,块状,1120</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="鹿角珊瑚属,枝状,860,无" />
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">覆盖导入</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="reviewVisible"
      :title="records.find((item) => item.id === reviewRecordId)?.review ? '修改下水复查' : '补记下水复查'"
      width="540px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="每条记录最多补记一次复查；保存后覆盖率、白化指数与白化占比改按复查值统计，初查值保留备查。"
        class="page__review-alert"
      />
      <el-form label-width="120px">
        <el-form-item label="调查日期">
          <span class="gb-mono">{{ belt?.surveyDate }}</span>
          <span class="gb-hint">（复查日期不得早于此日期）</span>
        </el-form-item>
        <el-form-item label="复查日期" required>
          <el-date-picker
            v-model="reviewForm.reviewDate"
            type="date"
            value-format="YYYY-MM-DD"
            :disabled-date="(date: Date) => belt ? date < new Date(`${belt.surveyDate}T00:00:00`) : false"
            placeholder="选择复查日期"
          />
        </el-form-item>
        <el-form-item label="复查覆盖长度" required>
          <el-input-number
            v-model="reviewForm.coverCm"
            :min="0"
            :max="belt ? belt.lengthM * 100 : 10000"
            :step="10"
            controls-position="right"
            @change="clampReviewCover"
          />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm，超出按全长记）</span>
          <div v-if="reviewClamped" class="gb-hint">复查长度超出样带全长，已按 {{ beltLengthCm }} cm 记。</div>
        </el-form-item>
        <el-form-item label="复查白化等级" required>
          <el-radio-group v-model="reviewForm.bleachLevel">
            <el-radio-button v-for="level in BLEACH_LEVELS" :key="`review-${level}`" :value="level">
              {{ level }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="success" :loading="reviewSaving" @click="submitReview">保存复查</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.page__sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: #4c6663;
}

.page__bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.page__legend-item {
  padding: 1px 8px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 11px;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
}

.gb-value-reviewed {
  color: #1e8449;
  font-weight: 600;
}

.gb-strike {
  text-decoration: line-through;
  color: #9bb3af;
}

.page__review-tag {
  margin-left: 6px;
}

.page__review-alert {
  margin-bottom: 14px;
}
</style>
