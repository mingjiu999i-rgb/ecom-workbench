import { initialData } from '../data/template'
import type { WorkbenchData } from '../types/models'

const STORAGE_KEY = 'ecom-workbench-data-v1'
const cloneInitialData = (): WorkbenchData => JSON.parse(JSON.stringify(initialData)) as WorkbenchData

export const storage = {
  load(): WorkbenchData {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? { ...cloneInitialData(), ...JSON.parse(saved) } : cloneInitialData()
    } catch {
      return cloneInitialData()
    }
  },
  save(data: WorkbenchData): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) },
  reset(): WorkbenchData { localStorage.removeItem(STORAGE_KEY); return cloneInitialData() },
}
