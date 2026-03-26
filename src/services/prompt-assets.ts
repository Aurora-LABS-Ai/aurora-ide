import {
  loadProjectRules,
  type ProjectRule,
} from "./context-builder";
import {
  getSkillCatalog,
  type SkillDefinition,
} from "./skills";

export type PromptAttachmentType = "rule" | "skill";

export interface PromptAttachment {
  description: string;
  id: string;
  key: string;
  sourceLabel: string;
  subtitle: string;
  title: string;
  type: PromptAttachmentType;
  ruleFilename?: string;
  skillStorageKey?: string;
}

export interface PromptAttachmentSelection {
  explicitSkillKeys: string[];
  ruleFilenames: string[];
}

function mapSkillSourceLabel(skill: SkillDefinition): string {
  if (skill.source === "workspace") {
    return "Project Skill";
  }

  if (skill.source === "global") {
    return "Global Skill";
  }

  return "Built-in Skill";
}

function mapSkillAttachment(skill: SkillDefinition): PromptAttachment {
  return {
    id: skill.id,
    key: `skill:${skill.storageKey}`,
    type: "skill",
    title: skill.name,
    subtitle: skill.id,
    description: skill.description,
    sourceLabel: mapSkillSourceLabel(skill),
    skillStorageKey: skill.storageKey,
  };
}

function mapRuleAttachment(rule: ProjectRule): PromptAttachment {
  const title = rule.filename.replace(/\.md$/i, "");

  return {
    id: title.toLowerCase(),
    key: `rule:${rule.filename}`,
    type: "rule",
    title,
    subtitle: rule.filename,
    description: `Project rule from .aurora/${rule.filename}`,
    sourceLabel: "Project Rule",
    ruleFilename: rule.filename,
  };
}

function sortPromptAttachments(left: PromptAttachment, right: PromptAttachment): number {
  if (left.type !== right.type) {
    return left.type === "rule" ? -1 : 1;
  }

  return left.title.localeCompare(right.title);
}

export async function loadPromptAttachments(
  workspacePath?: string | null,
  options?: {
    enabledSkillToggles?: Record<string, boolean>;
    skillsEnabled?: boolean;
  }
): Promise<PromptAttachment[]> {
  const [projectRules, enabledSkills] = await Promise.all([
    workspacePath ? loadProjectRules(workspacePath) : Promise.resolve([]),
    getSkillCatalog({
      workspacePath,
      enabledSkillToggles: options?.enabledSkillToggles,
      skillsEnabled: options?.skillsEnabled,
    }),
  ]);

  const attachments = [
    ...projectRules.map(mapRuleAttachment),
    ...enabledSkills.map(mapSkillAttachment),
  ];

  const deduped = new Map<string, PromptAttachment>();
  for (const attachment of attachments) {
    deduped.set(attachment.key, attachment);
  }

  return [...deduped.values()].sort(sortPromptAttachments);
}

export function getPromptAttachmentSelection(
  attachments: PromptAttachment[]
): PromptAttachmentSelection {
  const explicitSkillKeys: string[] = [];
  const ruleFilenames: string[] = [];

  for (const attachment of attachments) {
    if (attachment.type === "skill" && attachment.skillStorageKey) {
      explicitSkillKeys.push(attachment.skillStorageKey);
      continue;
    }

    if (attachment.type === "rule" && attachment.ruleFilename) {
      ruleFilenames.push(attachment.ruleFilename);
    }
  }

  return {
    explicitSkillKeys,
    ruleFilenames,
  };
}

export function filterProjectRulesByAttachment(
  rules: ProjectRule[],
  attachments: PromptAttachment[]
): ProjectRule[] {
  const selectedRuleNames = new Set(
    attachments
      .filter((attachment) => attachment.type === "rule" && attachment.ruleFilename)
      .map((attachment) => attachment.ruleFilename as string)
  );

  if (selectedRuleNames.size === 0) {
    return rules;
  }

  return rules.filter((rule) => selectedRuleNames.has(rule.filename));
}
