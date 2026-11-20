import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ArtifactRefineService } from './artifact-refine.service.js';
import { SpeechToTextService } from './speech-to-text.service.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';

type MockFn = ReturnType<typeof vi.fn>;

interface ChatServiceMock {
  createConversation: MockFn;
  clearMemory: MockFn;
  listPendingApprovals: MockFn;
}

type ControllerRequest = Parameters<ChatController['clearMemory']>[0];

interface TestUser {
  userId: string;
  email: string;
  role: string;
}

function createRequest(user?: TestUser): ControllerRequest {
  return { user } as unknown as ControllerRequest;
}

describe('ChatController', () => {
  let controller: ChatController;
  let chat: ChatServiceMock;
  let refine: { refine: MockFn };
  let speech: { transcribe: MockFn };

  beforeEach(async () => {
    chat = {
      createConversation: vi.fn(),
      clearMemory: vi.fn(),
      listPendingApprovals: vi.fn(),
    };
    refine = { refine: vi.fn() };
    speech = { transcribe: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: chat },
        { provide: ArtifactRefineService, useValue: refine },
        { provide: SpeechToTextService, useValue: speech },
      ],
    }).compile();

    controller = moduleRef.get(ChatController);
  });

  describe('clearMemory', () => {
    it('удаляет долговременную память текущего пользователя (GDPR)', async () => {
      chat.clearMemory.mockResolvedValue({ deleted: 4 });

      await expect(
        controller.clearMemory(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
        ),
      ).resolves.toEqual({ deleted: 4 });

      expect(chat.clearMemory).toHaveBeenCalledWith(USER_ID);
    });

    it('требует аутентификации', async () => {
      await expect(
        controller.clearMemory(createRequest()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(chat.clearMemory).not.toHaveBeenCalled();
    });
  });

  describe('listPendingApprovals', () => {
    it('возвращает ожидающие подтверждения текущего пользователя', async () => {
      chat.listPendingApprovals.mockResolvedValue([
        {
          conversationId: '11111111-1111-1111-1111-111111111111',
          reason: 'payment',
          tools: ['publish_to_dzen'],
          createdAt: '2026-11-13T12:00:00.000Z',
          expiresAt: '2026-11-14T12:00:00.000Z',
        },
      ]);

      await expect(
        controller.listPendingApprovals(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
        ),
      ).resolves.toEqual({
        items: [
          {
            conversationId: '11111111-1111-1111-1111-111111111111',
            reason: 'payment',
            tools: ['publish_to_dzen'],
            createdAt: '2026-11-13T12:00:00.000Z',
            expiresAt: '2026-11-14T12:00:00.000Z',
          },
        ],
      });

      expect(chat.listPendingApprovals).toHaveBeenCalledWith(USER_ID);
    });

    it('валидирует контракт ответа Zod-схемой', async () => {
      chat.listPendingApprovals.mockResolvedValue([
        {
          // Нарушение контракта: reason вне enum.
          conversationId: '11111111-1111-1111-1111-111111111111',
          reason: 'unknown',
          tools: [],
          createdAt: 'not-a-date',
        },
      ]);

      await expect(
        controller.listPendingApprovals(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
        ),
      ).rejects.toThrow();
    });

    it('требует аутентификации', async () => {
      await expect(
        controller.listPendingApprovals(createRequest()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(chat.listPendingApprovals).not.toHaveBeenCalled();
    });
  });

  describe('transcribe', () => {
    const body = {
      audioBase64: Buffer.from('audio').toString('base64'),
      mimeType: 'audio/webm',
      language: 'ru',
    };

    it('возвращает результат транскрибации', async () => {
      speech.transcribe.mockResolvedValue({
        text: 'привет',
        provider: 'mock',
      });

      const result = await controller.transcribe(
        createRequest({
          userId: USER_ID,
          email: 'user@example.com',
          role: 'user',
        }),
        undefined,
        body,
      );

      expect(result).toEqual({ text: 'привет', provider: 'mock' });
      expect(speech.transcribe).toHaveBeenCalledWith(body);
    });

    it('отвергает неподдерживаемый MIME у загруженного файла', async () => {
      await expect(
        controller.transcribe(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
          {
            buffer: Buffer.from('audio'),
            mimetype: 'video/mp4',
            size: 5,
            originalname: 'a.mp4',
          },
          {},
        ),
      ).rejects.toThrow();
      expect(speech.transcribe).not.toHaveBeenCalled();
    });
  });

  describe('refineArtifact', () => {
    const body = {
      artifactType: 'document',
      title: 'Договор',
      fullContent: 'Пункт 1\nПункт 2',
      selectedText: 'Пункт 2',
      instruction: 'Переформулируй',
    };

    it('возвращает обновлённый фрагмент и сводку', async () => {
      refine.refine.mockResolvedValue({
        updatedContent: 'Пункт 1\nНовый пункт 2',
        summary: 'Изменён пункт 2',
      });

      const result = await controller.refineArtifact(
        createRequest({
          userId: USER_ID,
          email: 'user@example.com',
          role: 'user',
        }),
        body,
      );

      expect(result.summary).toBe('Изменён пункт 2');
      expect(refine.refine).toHaveBeenCalledWith(body);
    });

    it('отвержает неавторизованный запрос', async () => {
      await expect(
        controller.refineArtifact(createRequest(), body),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(refine.refine).not.toHaveBeenCalled();
    });

    it('валидирует ответ сервиса через Zod', async () => {
      refine.refine.mockResolvedValue({ updatedContent: 'x' });

      await expect(
        controller.refineArtifact(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
          body,
        ),
      ).rejects.toThrow();
    });
  });
});
