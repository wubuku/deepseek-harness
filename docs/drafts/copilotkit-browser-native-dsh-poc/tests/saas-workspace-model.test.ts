import assert from 'node:assert/strict'
import test from 'node:test'
import { createSaaSWorkItem } from '../src/saas-workspace-model.ts'
import { initialSaaSWorkspace } from '../src/saas-workspace.tsx'

test('confirmed work-item operation updates the existing SaaS workspace', () => {
  const result = createSaaSWorkItem(
    initialSaaSWorkspace,
    { projectId: 'growth', title: 'Prepare launch review', priority: 'Medium', assignee: 'You' },
    'work-test-1',
    'saas-create:test-1',
  )

  assert.equal(result.result.ok, true)
  assert.equal(result.result.operationId, 'saas-create:test-1')
  assert.equal(result.result.project, 'Growth launch')
  assert.equal(result.result.priority, 'Medium')
  assert.equal(result.result.assignee, 'You')
  assert.equal(result.workspace.projects.find(project => project.id === 'growth')?.openItems, 5)
  assert.deepEqual(result.workspace.workItems[0], result.item)
  assert.equal(initialSaaSWorkspace.workItems.length, 3)
})

test('unknown project fails before changing SaaS state', () => {
  assert.throws(
    () => createSaaSWorkItem(
      initialSaaSWorkspace,
      { projectId: 'missing', title: 'Invalid', priority: 'Low', assignee: 'You' },
      'work-test-2',
      'saas-create:test-2',
    ),
    /Unknown SaaS project: missing/,
  )
})
