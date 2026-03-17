import { AlertTriangle, HelpCircle, Lock } from 'lucide-react'
import { memo, useMemo, useState } from 'react'

import type { InteractiveQuestion, InteractiveRequest, InteractiveResponsePayload } from '@falcondeck/client-core'
import { Badge, Button, Input } from '@falcondeck/ui'

export type InteractiveRequestCardProps = {
  request: InteractiveRequest
  resolved?: boolean
  onRespond?: (response: InteractiveResponsePayload) => void | Promise<void>
}

function mergeQuestionAnswers(
  question: InteractiveQuestion,
  selectedOption: string | null,
  customAnswer: string,
) {
  const trimmedCustomAnswer = customAnswer.trim()
  if ((question.is_other || !question.options?.length) && trimmedCustomAnswer.length > 0) {
    return [trimmedCustomAnswer]
  }
  return selectedOption ? [selectedOption] : []
}

export const InteractiveRequestCard = memo(function InteractiveRequestCard({
  request,
  resolved = false,
  onRespond,
}: InteractiveRequestCardProps) {
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string | null>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const canRespond = !!onRespond && !resolved
  const questionAnswers = useMemo(
    () =>
      Object.fromEntries(
        request.questions.map((question) => [
            question.id,
            mergeQuestionAnswers(
              question,
              selectedOptions[question.id] ?? null,
              customAnswers[question.id] ?? '',
            ),
        ]),
      ),
    [customAnswers, request.questions, selectedOptions],
  )
  const allQuestionsAnswered =
    request.kind !== 'question' ||
    request.questions.every((question) => (questionAnswers[question.id] ?? []).length > 0)

  async function submit(response: InteractiveResponsePayload) {
    if (!onRespond) return
    setIsSubmitting(true)
    try {
      await onRespond(response)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="rounded-[var(--fd-radius-lg)] border border-warning/20 bg-warning-muted px-4 py-3">
      <div className="flex items-start gap-2.5">
        {request.kind === 'approval' ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        ) : (
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{request.title}</p>
            <Badge variant={resolved ? 'success' : request.kind === 'approval' ? 'warning' : 'info'}>
              {resolved ? 'Resolved' : request.kind === 'approval' ? 'Approval required' : 'Response required'}
            </Badge>
          </div>
          {request.detail ? (
            <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-secondary">{request.detail}</p>
          ) : null}
          {request.command ? (
            <pre className="mt-2 overflow-x-auto rounded-[var(--fd-radius-md)] bg-surface-1 px-2.5 py-1.5 font-mono text-[length:var(--fd-text-xs)] text-fg-secondary">
              {request.command}
            </pre>
          ) : null}

          {request.kind === 'question' ? (
            <div className="mt-3 space-y-3">
              {request.questions.map((question) => {
                const selected = selectedOptions[question.id] ?? null
                const customValue = customAnswers[question.id] ?? ''
                return (
                  <div
                    key={question.id}
                    className="rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1/70 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[length:var(--fd-text-xs)] font-semibold uppercase tracking-[0.08em] text-fg-muted">
                        {question.header}
                      </p>
                      {question.is_secret ? (
                        <Badge variant="default">
                          <Lock className="h-3 w-3" />
                          Secret
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-primary">{question.question}</p>
                    {question.options?.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {question.options.map((option) => {
                          const isSelected = selected === option.label
                          return (
                            <button
                              key={option.label}
                              type="button"
                              disabled={!canRespond || isSubmitting}
                              onClick={() =>
                                {
                                  setSelectedOptions((current) => {
                                    const nextValue =
                                      current[question.id] === option.label ? null : option.label
                                    return { ...current, [question.id]: nextValue }
                                  })
                                  setCustomAnswers((current) => ({
                                    ...current,
                                    [question.id]: '',
                                  }))
                                }
                              }
                              className={`rounded-[var(--fd-radius-md)] border px-2.5 py-1.5 text-left text-[length:var(--fd-text-xs)] transition-colors ${
                                isSelected
                                  ? 'border-accent bg-accent/15 text-fg-primary'
                                  : 'border-border-default bg-surface-2 text-fg-secondary hover:bg-surface-3'
                              }`}
                            >
                              <span className="block font-medium">{option.label}</span>
                              <span className="block text-fg-muted">{option.description}</span>
                            </button>
                          )
                        })}
                      </div>
                    ) : null}
                    {question.is_other || !question.options?.length ? (
                      <div className="mt-3">
                        <Input
                          type={question.is_secret ? 'password' : 'text'}
                          value={customValue}
                          disabled={!canRespond || isSubmitting}
                          onChange={(event) => {
                            const nextValue = event.target.value
                            setCustomAnswers((current) => ({
                              ...current,
                              [question.id]: nextValue,
                            }))
                            if (nextValue.trim().length > 0) {
                              setSelectedOptions((current) => ({
                                ...current,
                                [question.id]: null,
                              }))
                            }
                          }}
                          placeholder="Enter your answer"
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}

          {canRespond ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {request.kind === 'approval' ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={isSubmitting}
                    onClick={() => void submit({ kind: 'approval', decision: 'deny' })}
                  >
                    Deny
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={isSubmitting}
                    onClick={() => void submit({ kind: 'approval', decision: 'allow' })}
                  >
                    Allow
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isSubmitting}
                    onClick={() => void submit({ kind: 'approval', decision: 'always_allow' })}
                  >
                    Always
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={isSubmitting || !allQuestionsAnswered}
                  onClick={() =>
                    void submit({
                      kind: 'question',
                      answers: questionAnswers,
                    })
                  }
                >
                  Submit answers
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
})
