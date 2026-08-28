import { AlertTriangle, ArrowLeft, ArrowRight, HelpCircle, Lock } from 'lucide-react'
import { memo, useEffect, useMemo, useState, type KeyboardEvent } from 'react'

import {
  interactiveRequestEvidencePresentation,
  interactiveApprovalDecisions,
  isMcpElicitationRequest,
  safeExternalUrl,
  type InteractiveRequest,
  type InteractiveResponsePayload,
} from '@falcondeck/client-core'
import { Badge, Button, Input, Textarea } from '@falcondeck/ui'

import { isComposingKeyboardEvent } from '../lib/keyboard'
import { WebLinkAnchor } from '../lib/web-link-context'
import { CodeBlock } from './code-block'
import { MessageMarkdown } from './message-markdown'

export type InteractiveRequestCardProps = {
  request: InteractiveRequest
  pendingCount?: number
  resolved?: boolean
  onRespond?: (response: InteractiveResponsePayload) => void | Promise<void>
}

function mergeQuestionAnswers(selectedOption: string | null, customAnswer: string) {
  const trimmedCustomAnswer = customAnswer.trim()
  if (trimmedCustomAnswer.length > 0) {
    return [trimmedCustomAnswer]
  }
  return selectedOption ? [selectedOption] : []
}

export const InteractiveRequestCard = memo(function InteractiveRequestCard({
  request,
  pendingCount = 1,
  resolved = false,
  onRespond,
}: InteractiveRequestCardProps) {
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string | null>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [planFeedback, setPlanFeedback] = useState('')
  const evidence = interactiveRequestEvidencePresentation(request)
  const approvalDecisions = interactiveApprovalDecisions(request)
  const elicitation = isMcpElicitationRequest(request)
  const externalUrl = safeExternalUrl(evidence.path)

  const canRespond = !!onRespond && !resolved
  const questionAnswers = useMemo(
    () =>
      Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          mergeQuestionAnswers(selectedOptions[question.id] ?? null, customAnswers[question.id] ?? ''),
        ]),
      ),
    [customAnswers, request.questions, selectedOptions],
  )
  const allQuestionsAnswered =
    request.kind !== 'question' ||
    request.questions.every((question) => (questionAnswers[question.id] ?? []).length > 0)
  const currentQuestion = request.kind === 'question' ? (request.questions[currentQuestionIndex] ?? null) : null
  const currentQuestionAnswer =
    currentQuestion && request.kind === 'question' ? (questionAnswers[currentQuestion.id] ?? []) : []
  const currentQuestionAnswered = currentQuestionAnswer.length > 0
  const isLastQuestion = request.kind === 'question' ? currentQuestionIndex >= request.questions.length - 1 : true

  useEffect(() => {
    setCurrentQuestionIndex(0)
    setSelectedOptions({})
    setCustomAnswers({})
    setPlanFeedback('')
    setSubmitError(null)
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
    setSubmitError(null)
    try {
      await onRespond(response)
    } catch (error) {
      // Without this the card resets to its untouched state and the agent
      // stays blocked, with nothing to tell the user their answer was lost.
      setSubmitError(error instanceof Error ? error.message : 'Failed to send your response')
    } finally {
      setIsSubmitting(false)
    }
  }

  function openElicitationUrl() {
    if (!externalUrl || typeof document === 'undefined') return
    const anchor = document.createElement('a')
    anchor.href = externalUrl
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
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
      if (!allQuestionsAnswered) {
        const firstUnansweredIndex = request.questions.findIndex(
          (question) => (questionAnswers[question.id] ?? []).length === 0,
        )
        if (firstUnansweredIndex !== -1) setCurrentQuestionIndex(firstUnansweredIndex)
        return
      }
      void submit({
        kind: 'question',
        answers: questionAnswers,
      })
      return
    }
    setCurrentQuestionIndex((current) => Math.min(current + 1, request.questions.length - 1))
  }

  function handleQuestionInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isComposingKeyboardEvent(event)) return
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (currentQuestionAnswered && !isSubmitting) {
      handleAdvance()
    }
  }

  return (
    <div className="rounded-[var(--fd-radius-md)] border border-warning/20 bg-warning-muted px-4 py-3">
      <div className="flex items-start gap-2.5">
        {request.kind === 'approval' || request.kind === 'plan_approval' ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        ) : (
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{request.title}</p>
            <Badge variant={resolved ? 'success' : request.kind === 'question' ? 'info' : 'warning'}>
              {resolved
                ? 'Resolved'
                : request.kind === 'plan_approval'
                  ? 'Plan review required'
                  : elicitation && request.kind === 'approval'
                    ? 'Sign in required'
                    : request.kind === 'approval'
                      ? 'Approval required'
                      : 'Response required'}
            </Badge>
            {!resolved && pendingCount > 1 ? (
              <span className="text-[length:var(--fd-text-xs)] text-fg-muted">1 of {pendingCount}</span>
            ) : null}
          </div>
          {evidence.detail && request.kind !== 'plan_approval' ? (
            <p className="mt-1 whitespace-pre-wrap text-[length:var(--fd-text-xs)] text-fg-secondary">
              {evidence.detail}
            </p>
          ) : null}
          {evidence.command ? (
            <div className="mt-2">
              <CodeBlock code={evidence.command} language="command" previewLines={4} />
            </div>
          ) : null}
          {externalUrl ? (
            <p className="mt-2">
              <WebLinkAnchor
                href={externalUrl}
                className="break-all text-[length:var(--fd-text-xs)] text-accent underline-offset-2 hover:underline"
              >
                {externalUrl}
              </WebLinkAnchor>
            </p>
          ) : evidence.path ? (
            <p className="mt-1 break-all font-mono text-[length:var(--fd-text-xs)] text-fg-tertiary">{evidence.path}</p>
          ) : null}
          {elicitation && externalUrl && canRespond ? (
            <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-secondary">
              Open the link to finish sign-in, then continue.
            </p>
          ) : null}

          {request.kind === 'plan_approval' ? (
            // The plan is a document to read, not part of the warning chrome:
            // it gets the transcript's solid reading surface, body-size type,
            // and an explicit text colour so no host surface (approval bar,
            // activity card, remote web) can wash it out by inheritance.
            <div className="mt-3 max-h-[min(60vh,42rem)] overflow-y-auto rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-5 py-4 text-[length:var(--fd-text-md)] text-fg-primary">
              {evidence.detail ? (
                <MessageMarkdown text={evidence.detail} defer={false} interpretDirectives={false} />
              ) : (
                <p role="alert" className="text-[length:var(--fd-text-xs)] text-danger">
                  This provider did not supply a plan to review.
                </p>
              )}
            </div>
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
              <p
                id={`fd-question-${currentQuestion.id}`}
                className="mt-1 text-[length:var(--fd-text-sm)] text-fg-primary"
              >
                {currentQuestion.question}
              </p>
              {currentQuestion.options?.length ? (
                <div
                  role="radiogroup"
                  aria-labelledby={`fd-question-${currentQuestion.id}`}
                  className="mt-3 grid gap-2"
                >
                  {currentQuestion.options.map((option) => {
                    const isSelected = (selectedOptions[currentQuestion.id] ?? null) === option.label
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
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
                  autoComplete="off"
                  spellCheck={!currentQuestion.is_secret}
                  aria-labelledby={`fd-question-${currentQuestion.id}`}
                  value={customAnswers[currentQuestion.id] ?? ''}
                  disabled={!canRespond || isSubmitting}
                  onChange={(event) => handleQuestionChange(currentQuestion.id, event.target.value)}
                  onKeyDown={handleQuestionInputKeyDown}
                  placeholder={currentQuestion.options?.length ? 'Or type your own answer' : 'Enter your answer'}
                />
              </div>
            </div>
          ) : request.kind === 'question' ? (
            <p role="alert" className="mt-3 text-[length:var(--fd-text-xs)] text-danger">
              This provider did not supply a question to answer.
            </p>
          ) : null}

          {canRespond && (request.kind === 'approval' || request.kind === 'plan_approval' || currentQuestion) ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {request.kind === 'approval' ? (
                <>
                  {approvalDecisions.includes('deny') ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isSubmitting}
                      onClick={() => void submit({ kind: 'approval', decision: 'deny' })}
                    >
                      {elicitation ? 'Cancel' : 'Deny'}
                    </Button>
                  ) : null}
                  {approvalDecisions.includes('allow') ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={isSubmitting}
                      onClick={() => {
                        if (elicitation) openElicitationUrl()
                        void submit({ kind: 'approval', decision: 'allow' })
                      }}
                    >
                      {elicitation ? 'Continue' : 'Allow'}
                    </Button>
                  ) : null}
                  {approvalDecisions.includes('always_allow') ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isSubmitting}
                      onClick={() =>
                        void submit({
                          kind: 'approval',
                          decision: 'always_allow',
                        })
                      }
                    >
                      Always allow
                    </Button>
                  ) : null}
                </>
              ) : request.kind === 'plan_approval' ? (
                <div className="grid w-full gap-2">
                  <Textarea
                    aria-label="Requested plan changes"
                    value={planFeedback}
                    disabled={isSubmitting}
                    onChange={(event) => setPlanFeedback(event.target.value)}
                    placeholder="Describe changes you want before implementation"
                    rows={3}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isSubmitting}
                      onClick={() =>
                        void submit({
                          kind: 'plan_approval',
                          outcome: 'abandoned',
                        })
                      }
                    >
                      Abandon plan
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isSubmitting || !planFeedback.trim()}
                      onClick={() =>
                        void submit({
                          kind: 'plan_approval',
                          outcome: 'cancelled',
                          feedback: planFeedback.trim(),
                        })
                      }
                    >
                      Request changes
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={isSubmitting || !evidence.detail}
                      onClick={() =>
                        void submit({
                          kind: 'plan_approval',
                          outcome: 'approved',
                        })
                      }
                    >
                      Approve and implement
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {elicitation ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isSubmitting}
                      onClick={() => void submit({ kind: 'approval', decision: 'deny' })}
                    >
                      Decline
                    </Button>
                  ) : null}
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
          {request.kind === 'approval' && approvalDecisions.length === 0 ? (
            <p role="alert" className="mt-3 text-[length:var(--fd-text-xs)] text-danger">
              This provider did not supply an approval decision.
            </p>
          ) : null}
          {submitError ? (
            <p role="alert" className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
              {submitError}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
})
