"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/web/submit-button";
import type { JudgmentLabel, Severity } from "@/core/types";
import type { DiagnosisCategory } from "@/core/heartbeat";
import { labelJudgmentAction, type LabelState } from "../../app/issues/actions";

const IDLE: LabelState = { status: "idle" };

type Option = { value: string; label: string };

const SEVERITY_OPTIONS: Option[] = [
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
];
const CATEGORY_OPTIONS: Option[] = [
  { value: "env", label: "環境問題" },
  { value: "app", label: "app 問題" },
];

function VerdictFieldset({
  legend,
  name,
  correctName,
  options,
  aiAnswer,
  initialVerdict,
  initialCorrect,
}: {
  legend: string;
  name: string;
  correctName: string;
  options: Option[];
  aiAnswer: string;
  initialVerdict: string;
  initialCorrect: string;
}) {
  const [verdict, setVerdict] = useState(initialVerdict);
  const choices: Array<[string, string]> = [
    ["", "尚未標記"],
    ["correct", "判對"],
    ["wrong", "判錯"],
  ];
  return (
    <fieldset className="judgment-fieldset">
      <legend>{legend}</legend>
      <div className="judgment-choices">
        {choices.map(([value, text]) => (
          <label key={value} className="judgment-choice">
            <input
              type="radio"
              name={name}
              value={value}
              checked={verdict === value}
              onChange={() => setVerdict(value)}
            />
            {text}
          </label>
        ))}
      </div>
      <label className="judgment-correct">
        正確答案
        <select
          name={correctName}
          defaultValue={initialCorrect}
          disabled={verdict !== "wrong"}
        >
          <option value="">請選擇</option>
          {options
            .filter((o) => o.value !== aiAnswer)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </select>
      </label>
    </fieldset>
  );
}

export function JudgmentLabelForm({
  issueId,
  judgmentId,
  aiSeverity,
  aiCategory,
  label,
}: {
  issueId: string;
  judgmentId: string;
  aiSeverity: Severity;
  aiCategory: DiagnosisCategory;
  label: JudgmentLabel;
}) {
  const [state, action] = useActionState(
    labelJudgmentAction.bind(null, issueId, judgmentId),
    IDLE,
  );
  return (
    <form action={action} className="reg-form judgment-form">
      <VerdictFieldset
        legend="嚴重度"
        name="severityVerdict"
        correctName="severityCorrect"
        options={SEVERITY_OPTIONS}
        aiAnswer={aiSeverity}
        initialVerdict={label.severityVerdict ?? ""}
        initialCorrect={label.severityCorrect ?? ""}
      />
      <VerdictFieldset
        legend="類型"
        name="categoryVerdict"
        correctName="categoryCorrect"
        options={CATEGORY_OPTIONS}
        aiAnswer={aiCategory}
        initialVerdict={label.categoryVerdict ?? ""}
        initialCorrect={label.categoryCorrect ?? ""}
      />
      <SubmitButton pendingLabel="儲存中…">儲存標記</SubmitButton>
      {state.status === "error" && (
        <ul className="reg-errors" role="alert">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {state.status === "saved" && (
        <p className="reg-ok" role="status">
          已儲存
        </p>
      )}
    </form>
  );
}
