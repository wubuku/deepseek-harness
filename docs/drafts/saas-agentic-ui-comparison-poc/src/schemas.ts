/** Model and HTTP operation fields validated before opening a shared business form. */
import { z } from 'zod'

export const fieldsSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  assignee: z.enum(['林悦', '陈晨', '周宁']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: z.enum(['open', 'in_progress', 'resolved']).optional(),
  id: z.string().max(80).optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict()

export const operationSchema = z.object({
  operationId: z.string().min(1).max(240),
  kind: z.enum(['create_task', 'update_ticket', 'approve_invoice']),
  fields: fieldsSchema,
}).strict()

export type Operation = z.infer<typeof operationSchema>
export type BusinessFields = z.infer<typeof fieldsSchema>
export type OperationKind = Operation['kind']
