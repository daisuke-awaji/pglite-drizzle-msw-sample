import { relations } from 'drizzle-orm'
import {
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { PRIORITIES, PROJECT_COLORS, PROJECT_STATUSES, TASK_STATUSES } from '../shared/enums'

export const projectStatus = pgEnum('project_status', PROJECT_STATUSES)
export const projectColor = pgEnum('project_color', PROJECT_COLORS)
export const taskStatus = pgEnum('task_status', TASK_STATUSES)
export const taskPriority = pgEnum('task_priority', PRIORITIES)

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const members = pgTable('members', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  title: text('title').notNull().default(''),
  createdAt: createdAt(),
})

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  color: projectColor('color').notNull().default('gray'),
  status: projectStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// N:N（プロジェクト ⇔ メンバー）。どちらが消えても行ごと消える
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.memberId] }), index().on(t.memberId)],
)

// 1:N（プロジェクト → タスク）は CASCADE、N:1（タスク → 担当者）は SET NULL
export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('medium'),
    assigneeId: integer('assignee_id').references(() => members.id, { onDelete: 'set null' }),
    dueDate: date('due_date', { mode: 'string' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.projectId, t.status), index().on(t.assigneeId)],
)

export const tags = pgTable('tags', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
})

// N:N（タスク ⇔ タグ）
export const taskTags = pgTable(
  'task_tags',
  {
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] }), index().on(t.tagId)],
)

// 1:N（タスク → コメント）。書いた人が消えてもコメントは残す
export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: integer('author_id').references(() => members.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.taskId)],
)

export const membersRelations = relations(members, ({ many }) => ({
  projectMembers: many(projectMembers),
  assignedTasks: many(tasks),
  comments: many(comments),
}))

export const projectsRelations = relations(projects, ({ many }) => ({
  projectMembers: many(projectMembers),
  tasks: many(tasks),
}))

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  member: one(members, { fields: [projectMembers.memberId], references: [members.id] }),
}))

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee: one(members, { fields: [tasks.assigneeId], references: [members.id] }),
  taskTags: many(taskTags),
  comments: many(comments),
}))

export const tagsRelations = relations(tags, ({ many }) => ({
  taskTags: many(taskTags),
}))

export const taskTagsRelations = relations(taskTags, ({ one }) => ({
  task: one(tasks, { fields: [taskTags.taskId], references: [tasks.id] }),
  tag: one(tags, { fields: [taskTags.tagId], references: [tags.id] }),
}))

export const commentsRelations = relations(comments, ({ one }) => ({
  task: one(tasks, { fields: [comments.taskId], references: [tasks.id] }),
  author: one(members, { fields: [comments.authorId], references: [members.id] }),
}))
