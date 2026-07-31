import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { ALLOWED_IMAGE_MIMES, removeFile, uploadFile } from '../storage';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
      cb(HttpError.badRequest(`Formato no permitido: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

const FOLDERS = ['vehicles', 'evidences', 'logos', 'avatars'] as const;
const folderSchema = z.enum(FOLDERS).default('evidences');

export const uploadsRouter = Router();

uploadsRouter.use(requireAuth);

/** POST /api/uploads · una sola imagen (campo: file) */
uploadsRouter.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw HttpError.badRequest('No se recibió ningún archivo (campo "file")');
    const folder = folderSchema.parse(req.body?.folder ?? undefined);

    const stored = await uploadFile({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalName: req.file.originalname,
      folder,
    });

    res.status(201).json(stored);
  }),
);

/** POST /api/uploads/batch · varias imágenes (campo: files) */
uploadsRouter.post(
  '/batch',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw HttpError.badRequest('No se recibieron archivos (campo "files")');
    const folder = folderSchema.parse(req.body?.folder ?? undefined);

    const stored = await Promise.all(
      files.map((file) =>
        uploadFile({
          buffer: file.buffer,
          mimetype: file.mimetype,
          originalName: file.originalname,
          folder,
        }),
      ),
    );

    res.status(201).json({ files: stored });
  }),
);

/** DELETE /api/uploads?path=... */
uploadsRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const key = z.string().min(1, 'Indica el path del archivo').parse(req.query.path);
    await removeFile(key);
    res.status(204).send();
  }),
);
