import { AlertTriangle, ArrowLeft, ArrowRight, HelpCircle, Lock } from 'lucide-react'
import { memo, useEffect, useMemo, useState, type KeyboardEvent } from 'react'

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
  if (trimmedCustomAnswer.length > 0) {
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
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
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
  const currentQuestion = request.kind === 'question' ? request.questions[currentQuestionIndex] ?? null : null
  const currentQuestionAnswer =
    currentQuestion && request.kind === 'question' ? (questionAnswers[currentQuestion.id] ?? []) : []
  const currentQuestionAnswered = currentQuestionAnswer.length > 0
  const isLastQuestion =
    request.kind === 'question' ? currentQuestionIndex >= request.questions.length - 1 : true

  useEffect(() => {
    setCurrentQuestionIndex(0)
    setSelectedOptions({})
    setCustomAnswers({})
  }, [request.request_id])

  useEffect(() => {
    if (request.kind !== 'question' || request.questions.length === 0) return
    const firstUnansweredIndex = request.questions.findIndex(
      (question) => (questionAnswers[question.id] ?? []).length === 0,
    )
    if (firstUnansweredIndex !== -1 && firstUnansweredIndex < currentQuestionIndex) {
      setCurrentQuestionIndex(firstUnansweredIndex)
    }
  }, [currentQuestionIndex, questionAnswers, request.kind, request.questions])

  async function submit(response: InteractiveResponsePayload) {
    if (!onRespond) return
    setIsSubmitting(true)
    try {
      await onRespond(response)
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleQuestionChange(questionId: string, value: string) {
    setCustomAnswers((current) => ({
      ...current,
      [questionId]: value,
    }))
    if (value.trim().length > 0) {
      setSelectedOptions((current) => ({
        ...current,
        [questionId]: null,
      }))
    }
  }

  function handleAdvance() {
    if (!currentQuestion || !currentQuestionAnswered) return
    if (isLastQuestion) {
      void submit({
        kind: 'question',
        answers: questionAnswers,
      })
      return
    }
    setCurrentQuestionIndex((current) => Math.min(current + 1, request.questions.length - 1))
  }

  function handleQuestionInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (currentQuestionAnswered && !isSubmitting) {
      handleAdvance()
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

          {request.kind === 'question' && currentQuestion ? (
            <div className="mt-3 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[length:var(--fd-text-xs)] font-semibold uppercase tracking-[0.08em] text-fg-muted">
                    {currentQuestion.header}
                  </p>
                  {currentQuestion.is_secret ? (
                    <Badge variant="default">
                      <Lock className="h-3 w-3" />
                      Secret
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  {currentQuestionIndex + 1} of {request.questions.length}
                </p>
              </div>
              <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-primary">{currentQuestion.question}</p>
              {currentQuestion.options?.length ? (
                <div className="mt-3 grid gap-2">
                  {currentQuestion.options.map((option) => {
                    const isSelected = (selectedOptions[currentQuestion.id] ?? null) === option.label
                    return (
                      <button
                        key={option.label}
                        type="button"
                        disabled={!canRespond || isSubmitting}
                        onClick={() => {
                          setSelectedOptions((current) => ({
                            ...current,
                            [currentQuestion.id]: option.label,
                          }))
                          setCustomAnswers((current) => ({
                            ...current,
                            [currentQuestion.id]: '',
                          }))
                        }}
                        className={`w-full rounded-[var(--fd-radius-md)] border px-4 py-3 text-left transition-colors ${
                          isSelected
                            ? 'border-accent bg-accent/15 text-fg-primary'
                            : 'border-border-default bg-surface-2 text-fg-secondary hover:border-border-emphasis hover:bg-surface-3'
                        }`}
                      >
                        <span className="block font-medium text-[length:var(--fd-text-sm)]">{option.label}</span>
                        <span className="mt-1 block text-[length:var(--fd-text-xs)] text-fg-muted">
                          {option.description}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
              <div className="mt-3">
                <Input
                  type={currentQuestion.is_secret ? 'password' : 'text'}
                  value={customAnswers[currentQuestion.id] ?? ''}
                  disabled={!canRespond || isSubmitting}
                  onChange={(event) => handleQuestionChange(currentQuestion.id, event.target.value)}
                  onKeyDown={handleQuestionInputKeyDown}
                  placeholder={
                    currentQuestion.options?.length ? 'Or type your own answer' : 'Enter your answer'
                  }
                />
              </div>
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
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isSubmitting || currentQuestionIndex === 0}
                    onClick={() => setCurrentQuestionIndex((current) => Math.max(current - 1, 0))}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={isSubmitting || !currentQuestionAnswered}
                    onClick={handleAdvance}
                  >
                    {isLastQuestion ? 'Submit answer' : 'Next question'}
                    {!isLastQuestion ? <ArrowRight className="h-4 w-4" /> : null}
                  </Button>
                  {allQuestionsAnswered && !isLastQuestion ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isSubmitting}
                      onClick={() =>
                        void submit({
                          kind: 'question',
                          answers: questionAnswers,
                        })
                      }
                    >
                      Submit now
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
})
