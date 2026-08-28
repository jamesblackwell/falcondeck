import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, HelpCircle, Lock } from "lucide-react-native";
import * as Haptics from "expo-haptics";

import {
  interactiveApprovalDecisions,
  type ApprovalDecision,
  InteractiveRequest,
  InteractiveResponsePayload,
} from "@falcondeck/client-core";

import { Button, Input, Text } from "@/components/ui";
import { ApprovalBanner } from "./ApprovalBanner";
import { MarkdownRenderer } from "./MarkdownRenderer";

type Props = {
  request: InteractiveRequest;
  pendingCount?: number;
  onRespond: (response: InteractiveResponsePayload) => void | Promise<void>;
};

function mergedAnswer(
  selectedOption: string | null,
  customAnswer: string,
): string[] {
  const custom = customAnswer.trim();
  if (custom) return [custom];
  return selectedOption ? [selectedOption] : [];
}

export const InteractiveRequestBanner = memo(function InteractiveRequestBanner({
  request,
  pendingCount = 1,
  onRespond,
}: Props) {
  if (request.kind === "approval") {
    const decisions = interactiveApprovalDecisions(request);
    const respond = (decision: ApprovalDecision) =>
      onRespond({ kind: "approval", decision });
    return (
      <ApprovalBanner
        approval={request}
        pendingCount={pendingCount}
        onAllow={
          decisions.includes("allow") ? () => respond("allow") : undefined
        }
        onDeny={decisions.includes("deny") ? () => respond("deny") : undefined}
        onAlways={
          decisions.includes("always_allow")
            ? () => respond("always_allow")
            : undefined
        }
      />
    );
  }

  if (request.kind === "plan_approval") {
    return (
      <PlanApprovalBanner
        request={request}
        pendingCount={pendingCount}
        onRespond={onRespond}
      />
    );
  }

  return (
    <QuestionBanner
      request={request}
      pendingCount={pendingCount}
      onRespond={onRespond}
    />
  );
});

const PlanApprovalBanner = memo(function PlanApprovalBanner({
  request,
  pendingCount = 1,
  onRespond,
}: Props) {
  const { theme } = useUnistyles();
  const [feedback, setFeedback] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setFeedback("");
    setSubmitError(null);
  }, [request.request_id]);

  async function submit(outcome: "approved" | "cancelled" | "abandoned") {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onRespond({
        kind: "plan_approval",
        outcome,
        feedback: outcome === "cancelled" ? feedback.trim() : undefined,
      });
      void Haptics.notificationAsync(
        outcome === "abandoned"
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Failed to send your response",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View
      style={[styles.container, styles.planContainer]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.header}>
        <View style={styles.icon}>
          <HelpCircle
            accessible={false}
            size={16}
            color={theme.colors.warning.default}
          />
        </View>
        <View style={styles.heading}>
          <Text variant="caption" color="warning" weight="semibold">
            Plan review required
          </Text>
          <Text selectable variant="label" color="primary">
            {request.title}
          </Text>
        </View>
        {pendingCount > 1 ? (
          <Text variant="caption" color="muted">
            1 of {pendingCount}
          </Text>
        ) : null}
      </View>

      {request.detail ? (
        // The plan is a document to read: full markdown at body size on a
        // solid surface, capped so a long plan scrolls instead of pushing
        // the feedback field and buttons off screen.
        <ScrollView
          style={styles.planContent}
          contentContainerStyle={styles.planContentInner}
          nestedScrollEnabled
        >
          <MarkdownRenderer text={request.detail} interpretDirectives={false} />
        </ScrollView>
      ) : (
        <View style={[styles.planContent, styles.planContentInner]}>
          <Text selectable variant="caption" color="secondary">
            This provider did not supply a plan to review.
          </Text>
        </View>
      )}

      <Input
        accessibilityLabel="Requested plan changes"
        value={feedback}
        editable={!isSubmitting}
        multiline
        numberOfLines={3}
        placeholder="Describe changes you want before implementation"
        onChangeText={setFeedback}
      />

      <View style={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          label="Abandon plan"
          disabled={isSubmitting}
          onPress={() => void submit("abandoned")}
        />
        <Button
          variant="secondary"
          size="sm"
          label="Request changes"
          disabled={isSubmitting || !feedback.trim()}
          onPress={() => void submit("cancelled")}
        />
        <Button
          variant="default"
          size="sm"
          label="Approve and implement"
          loading={isSubmitting}
          disabled={isSubmitting || !request.detail}
          onPress={() => void submit("approved")}
        />
      </View>

      {submitError ? (
        <Text accessibilityRole="alert" variant="caption" color="danger">
          {submitError}
        </Text>
      ) : null}
    </View>
  );
});

const QuestionBanner = memo(function QuestionBanner({
  request,
  pendingCount = 1,
  onRespond,
}: Props) {
  const { theme } = useUnistyles();
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, string | null>
  >({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(
    {},
  );
  const [questionIndex, setQuestionIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedOptions({});
    setCustomAnswers({});
    setQuestionIndex(0);
    setSubmitError(null);
  }, [request.request_id]);

  useEffect(() => {
    setQuestionIndex((current) =>
      Math.min(current, Math.max(0, request.questions.length - 1)),
    );
  }, [request.questions.length]);

  const answers = useMemo(
    () =>
      Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          mergedAnswer(
            selectedOptions[question.id] ?? null,
            customAnswers[question.id] ?? "",
          ),
        ]),
      ),
    [customAnswers, request.questions, selectedOptions],
  );
  const question = request.questions[questionIndex] ?? null;
  const answered = question ? (answers[question.id]?.length ?? 0) > 0 : false;
  const lastQuestion = questionIndex >= request.questions.length - 1;
  const allAnswered = request.questions.every(
    (entry) => (answers[entry.id]?.length ?? 0) > 0,
  );

  async function submit() {
    if (!allAnswered || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onRespond({ kind: "question", answers });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Failed to send your response",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSubmitting(false);
    }
  }

  function advance() {
    if (!answered || isSubmitting) return;
    if (lastQuestion) {
      void submit();
      return;
    }
    setQuestionIndex((current) =>
      Math.min(current + 1, request.questions.length - 1),
    );
  }

  return (
    <View style={styles.container} accessibilityLiveRegion="polite">
      <View style={styles.header}>
        <View style={styles.icon}>
          <HelpCircle
            accessible={false}
            size={16}
            color={theme.colors.info.default}
          />
        </View>
        <View style={styles.heading}>
          <Text variant="caption" color="info" weight="semibold">
            Response required
          </Text>
          <Text selectable variant="label" color="primary">
            {request.title}
          </Text>
        </View>
        {pendingCount > 1 ? (
          <Text variant="caption" color="muted">
            1 of {pendingCount}
          </Text>
        ) : null}
      </View>

      {request.detail ? (
        <Text selectable variant="caption" color="secondary">
          {request.detail}
        </Text>
      ) : null}

      {question ? (
        <View style={styles.question}>
          <View style={styles.questionHeader}>
            <Text selectable variant="caption" color="muted" weight="semibold">
              {question.header}
            </Text>
            {question.is_secret ? (
              <View
                style={styles.secretBadge}
                accessible
                accessibilityLabel="Secret answer"
              >
                <Lock
                  accessible={false}
                  size={12}
                  color={theme.colors.fg.muted}
                />
                <Text variant="caption" color="muted" size="2xs">
                  Secret
                </Text>
              </View>
            ) : null}
            <Text
              variant="caption"
              color="muted"
              size="2xs"
              style={styles.progress}
            >
              {questionIndex + 1} of {request.questions.length}
            </Text>
          </View>
          <Text selectable variant="body" color="primary">
            {question.question}
          </Text>

          {question.options?.length ? (
            <View style={styles.options} accessibilityRole="radiogroup">
              {question.options.map((option) => {
                const selected = selectedOptions[question.id] === option.label;
                return (
                  <Pressable
                    key={option.label}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityHint={option.description || undefined}
                    accessibilityState={{
                      checked: selected,
                      disabled: isSubmitting,
                    }}
                    disabled={isSubmitting}
                    onPress={() => {
                      setSelectedOptions((current) => ({
                        ...current,
                        [question.id]: option.label,
                      }));
                      setCustomAnswers((current) => ({
                        ...current,
                        [question.id]: "",
                      }));
                    }}
                    style={[
                      styles.option,
                      selected ? styles.optionSelected : null,
                    ]}
                  >
                    <View
                      style={[
                        styles.radio,
                        selected ? styles.radioSelected : null,
                      ]}
                    >
                      {selected ? (
                        <Check
                          accessible={false}
                          size={12}
                          color={theme.colors.surface[0]}
                        />
                      ) : null}
                    </View>
                    <View style={styles.optionCopy}>
                      <Text variant="caption" color="primary" weight="semibold">
                        {option.label}
                      </Text>
                      {option.description ? (
                        <Text variant="caption" color="muted" size="2xs">
                          {option.description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <Input
            accessibilityLabel={question.question}
            value={customAnswers[question.id] ?? ""}
            editable={!isSubmitting}
            secureTextEntry={question.is_secret}
            autoCorrect={!question.is_secret}
            autoCapitalize={question.is_secret ? "none" : "sentences"}
            returnKeyType={lastQuestion ? "send" : "next"}
            placeholder={
              question.options?.length
                ? "Or type your own answer"
                : "Enter your answer"
            }
            onChangeText={(value) => {
              setCustomAnswers((current) => ({
                ...current,
                [question.id]: value,
              }));
              if (value.trim()) {
                setSelectedOptions((current) => ({
                  ...current,
                  [question.id]: null,
                }));
              }
            }}
            onSubmitEditing={advance}
          />
        </View>
      ) : (
        <Text accessibilityRole="alert" variant="caption" color="danger">
          This provider did not supply a question to answer.
        </Text>
      )}

      {question ? (
        <View style={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            label="Back"
            disabled={isSubmitting || questionIndex === 0}
            onPress={() =>
              setQuestionIndex((current) => Math.max(current - 1, 0))
            }
          />
          {allAnswered && !lastQuestion ? (
            <Button
              variant="secondary"
              size="sm"
              label="Submit now"
              disabled={isSubmitting}
              onPress={() => void submit()}
            />
          ) : null}
          <Button
            variant="default"
            size="sm"
            label={lastQuestion ? "Submit answer" : "Next question"}
            loading={isSubmitting}
            disabled={!answered || isSubmitting}
            onPress={advance}
          />
        </View>
      ) : null}

      {submitError ? (
        <Text accessibilityRole="alert" variant="caption" color="danger">
          {submitError}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[3],
    marginVertical: theme.spacing[1],
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.info.default,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    backgroundColor: theme.colors.info.muted,
    padding: theme.spacing[3],
  },
  planContainer: {
    borderColor: theme.colors.warning.default,
    backgroundColor: theme.colors.warning.muted,
  },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface[1],
  },
  heading: { flex: 1, gap: 1 },
  planContent: {
    maxHeight: 320,
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    borderRadius: theme.radius.md,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[1],
  },
  planContentInner: {
    padding: theme.spacing[3],
  },
  question: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    borderRadius: theme.radius.md,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[1],
    padding: theme.spacing[3],
  },
  questionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  secretBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  progress: { marginLeft: "auto" },
  options: { gap: theme.spacing[2] },
  option: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.radius.md,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  optionSelected: {
    borderColor: theme.colors.accent.default,
    backgroundColor: theme.colors.accent.muted,
  },
  radio: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border.emphasis,
    borderRadius: 10,
  },
  radioSelected: {
    borderColor: theme.colors.accent.default,
    backgroundColor: theme.colors.accent.default,
  },
  optionCopy: { flex: 1, gap: theme.spacing[1] },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
