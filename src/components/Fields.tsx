import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export function Field({ label, children, full = false }: { label: string; children: ReactNode; full?: boolean }) {
  return <label className={`field ${full ? 'field-full' : ''}`}><span>{label}</span>{children}</label>
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} /> }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} /> }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea rows={3} {...props} /> }
