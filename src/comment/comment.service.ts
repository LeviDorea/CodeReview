import { Injectable } from '@nestjs/common';
import { ReviewIssue } from '../analysis/review-issue.types';
import { detectLanguageFromFilename } from '../common/utils/file-language.util';

export interface CommentData {
  score: number;
  prTitle: string;
  issues: ReviewIssue[];
}

@Injectable()
export class CommentService {
  private readonly ICONS: Record<string, string> = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
  };

  private readonly LABELS: Record<string, string> = {
    high: 'Alta Criticidade',
    medium: 'Média Criticidade',
    low: 'Baixa Criticidade',
  };

  formatMarkdown(data: CommentData): string {
    const { score, issues } = data;
    const indicator = score >= 80 ? '✅' : score >= 50 ? '⚠️' : '❌';
    const knownDebtIssues = issues.filter((issue) => issue.baselineStatus === 'known_debt');
    const scoredIssues = issues.filter(
      (issue) => !issue.advisory && issue.baselineStatus !== 'known_debt',
    );
    const advisoryIssues = issues.filter(
      (issue) => issue.advisory && issue.baselineStatus !== 'known_debt',
    );

    const sections: string[] = [];

    const highCount = scoredIssues.filter((i) => i.criticality === 'high').length;
    const mediumCount = scoredIssues.filter((i) => i.criticality === 'medium').length;
    const lowCount = scoredIssues.filter((i) => i.criticality === 'low').length;

    if (scoredIssues.length > 0 || knownDebtIssues.length > 0 || advisoryIssues.length > 0) {
      sections.push('| 🔴 Alta | 🟡 Média | 🟢 Baixa | 🧱 Known Debt | ℹ️ Observações |');
      sections.push('|:---:|:---:|:---:|:---:|:---:|');
      sections.push(
        `| ${highCount} | ${mediumCount} | ${lowCount} | ${knownDebtIssues.length} | ${advisoryIssues.length} |`,
      );
      sections.push('');
    }

    for (const level of ['high', 'medium', 'low'] as const) {
      const levelIssues = scoredIssues.filter((i) => i.criticality === level);
      if (levelIssues.length === 0) continue;

      const icon = this.ICONS[level];
      const label = this.LABELS[level];

      sections.push(`### ${icon} ${label} (${levelIssues.length} problema${levelIssues.length > 1 ? 's' : ''})`);
      sections.push('');

      for (const issue of levelIssues) {
        const statusSuffix =
          issue.baselineStatus === 'new'
            ? ' 🆕'
            : issue.baselineStatus === 'persistent'
              ? ' ♻️'
              : '';
        sections.push(this.renderIssueDetails(issue, statusSuffix));
      }
    }

    if (knownDebtIssues.length > 0) {
      sections.push(
        this.renderCollapsedSection(
          `🧱 Known Debt (${knownDebtIssues.length} sem impacto na nota)`,
          knownDebtIssues,
        ),
      );
    }

    if (advisoryIssues.length > 0) {
      sections.push(
        this.renderCollapsedSection(
          `ℹ️ Observações Adicionais (${advisoryIssues.length} sem impacto na nota)`,
          advisoryIssues,
        ),
      );
    }

    const noIssuesMessage =
      scoredIssues.length === 0 && advisoryIssues.length === 0 && knownDebtIssues.length === 0
        ? '\n\n> ✅ Nenhum problema encontrado. Excelente trabalho!\n'
        : scoredIssues.length === 0
          ? '\n\n> ✅ Nenhum problema com impacto na nota foi encontrado.\n'
          : '';

    return [
      `## 🤖 PRzator — Análise Automática`,
      '',
      `**Nota: ${score}/100** ${indicator}`,
      '',
      '---',
      '',
      ...sections,
      noIssuesMessage,
      '---',
      `*Gerado por PRzator Bot em ${this.formatTimestamp(new Date())}*`,
    ].join('\n');
  }

  private renderIssueDetails(issue: ReviewIssue, statusSuffix = ''): string {
    const lines: string[] = [];
    const statusLine =
      issue.baselineStatus === 'new'
        ? 'Nova neste commit'
        : issue.baselineStatus === 'persistent'
          ? 'Persistente'
          : issue.baselineStatus === 'known_debt'
            ? 'Preexistente / descoberto agora'
            : null;

    lines.push('<details>');
    lines.push(`<summary><code>${issue.file}</code>${statusSuffix} — ${issue.description}</summary>`);
    lines.push('');
    lines.push(`**Regra:** ${issue.rule}`);
    if (statusLine) {
      lines.push(`**Status:** ${statusLine}`);
    }
    lines.push(`**Motivo:** ${issue.reason}`);
    if (issue.snippet) {
      const language = detectLanguageFromFilename(issue.file) ?? '';
      lines.push('');
      lines.push('```' + language);
      lines.push(issue.snippet);
      lines.push('```');
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
    return lines.join('\n');
  }

  private renderCollapsedSection(title: string, sectionIssues: ReviewIssue[]): string {
    const lines: string[] = [];
    lines.push('<details>');
    lines.push(`<summary><strong>${title}</strong></summary>`);
    lines.push('');
    for (const issue of sectionIssues) {
      lines.push(this.renderIssueDetails(issue));
    }
    lines.push('</details>');
    lines.push('');
    return lines.join('\n');
  }

  private formatTimestamp(date: Date): string {
    return date.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatFailureComment(prNumber: number, error: string): string {
    return [
      `## 🤖 PRzator — Análise Automática`,
      '',
      `> ❌ A análise do PR #${prNumber} falhou.`,
      `> **Erro:** ${error}`,
      '',
      '*Por favor, verifique os logs do sistema.*',
    ].join('\n');
  }
}
