import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GithubService } from '../github/github.service';
import { CreateRepositoryDto } from './dto/create-repository.dto';

@Injectable()
export class RepositoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
  ) {}

  async findAvailable() {
    const installationId = await this.github.getOrgInstallationId();
    const repos = await this.github.listOrgRepositories(installationId);
    return repos.map((r) => ({ ...r, installationId }));
  }

  async create(dto: CreateRepositoryDto) {
    const existing = await this.prisma.repository.findUnique({
      where: { fullName: dto.fullName },
    });
    if (existing) {
      throw new ConflictException('Repository already registered');
    }

    // No per-repo webhook is created here on purpose: the GitHub App's own
    // central webhook already delivers pull_request events for every
    // installed repository. Creating one here as well used to cause every
    // PR event to be delivered twice, racing two full analysis pipelines
    // against the same commit.
    return this.prisma.repository.create({
      data: { ...dto, webhookId: null },
    });
  }

  async findAll() {
    return this.prisma.repository.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async remove(id: string) {
    const repo = await this.prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      throw new NotFoundException('Repository not found');
    }

    if (repo.webhookId) {
      await this.github.removeWebhook(
        repo.owner,
        repo.name,
        repo.installationId,
        repo.webhookId,
      );
    }

    return this.prisma.repository.delete({ where: { id } });
  }
}
