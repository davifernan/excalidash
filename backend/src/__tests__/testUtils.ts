/**
 * Test utilities for backend integration tests
 */
import { PrismaClient } from "../generated/client";
import path from "path";
import { execSync } from "child_process";

const TEST_ISOLATION_ID = `${process.pid}_${Math.random().toString(16).slice(2)}`;
const TEST_DB_FILENAME = `test.${TEST_ISOLATION_ID}.db`;
const TEST_DB_PATH = path.resolve(__dirname, "../../prisma", TEST_DB_FILENAME);

/**
 * Where this test process keeps its data, and on which engine.
 *
 * `EXCALIDASH_TEST_DATABASE_URL` points the whole suite at PostgreSQL. Without
 * it nothing changes: every process still gets its own SQLite file.
 *
 * Isolation differs by engine and that is the point of doing it here rather
 * than per suite. SQLite isolates by FILE -- a name nobody else uses. Postgres
 * has one server, so it isolates by SCHEMA instead, named from the same id.
 * Sharing one Postgres database between parallel workers without that would
 * make them tear down each other's tables, and the failures would look like
 * flaky product behaviour rather than a test-harness fault.
 */
const POSTGRES_TEST_SCHEMA = `test_${TEST_ISOLATION_ID}`;

const resolveTestDatabase = (): { url: string; provider: "sqlite" | "postgresql" } => {
  const configured = (process.env.EXCALIDASH_TEST_DATABASE_URL || "").trim();
  if (!configured) return { url: `file:${TEST_DB_PATH}`, provider: "sqlite" };

  const separator = configured.includes("?") ? "&" : "?";
  return {
    url: `${configured}${separator}schema=${POSTGRES_TEST_SCHEMA}`,
    provider: "postgresql",
  };
};

const testDatabase = resolveTestDatabase();

/** Which engine the suite is running against, for tests that need to know. */
export const testDatabaseProvider = testDatabase.provider;

/**
 * Get a test Prisma client pointing to the test database
 */
export const getTestPrisma = () => {
  process.env.DATABASE_URL = testDatabase.url;
  process.env.DATABASE_PROVIDER = testDatabase.provider;
  return new PrismaClient({
    datasources: {
      db: {
        url: testDatabase.url,
      },
    },
  });
};

/**
 * Setup the test database by running migrations
 */
export const setupTestDb = () => {
  process.env.DATABASE_URL = testDatabase.url;
  process.env.DATABASE_PROVIDER = testDatabase.provider;

  try {
    // Every test process owns its own SQLite file, or its own Postgres schema.
    // Serializing db push across processes therefore protects no shared
    // database; it only turns several independent setup jobs into one queue
    // whose fixed wait budget expires on a loaded CI host.
    //
    // Routed through provider-prisma.cjs rather than calling prisma directly:
    // the schema file names one provider, and that script is what rewrites it
    // in a disposable workspace. Calling `npx prisma` here would push a SQLite
    // schema into Postgres.
    execSync("node scripts/provider-prisma.cjs db push --skip-generate --force-reset", {
      cwd: path.resolve(__dirname, "../../"),
      env: {
        ...process.env,
        DATABASE_URL: testDatabase.url,
        DATABASE_PROVIDER: testDatabase.provider,
        RUST_LOG: "info",
      },
      stdio: "pipe",
    });
  } catch (error) {
    console.error("Failed to setup test database:", error);
    throw error;
  }
};

/**
 * Clean up the test database between tests
 */
export const cleanupTestDb = async (prisma: PrismaClient) => {
  await prisma.apiKey.deleteMany({});
  await prisma.drawing.deleteMany({});
  await prisma.collection.deleteMany({});
};

/**
 * Create a test user for testing
 */
export const createTestUser = async (prisma: PrismaClient, email: string = "test@example.com") => {
  const bcrypt = require("bcrypt");
  const passwordHash = await bcrypt.hash("testpassword", 10);

  return await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      name: "Test User",
    },
  });
};

/**
 * Initialize test database with required data
 */
export const initTestDb = async (prisma: PrismaClient) => {
  const testUser = await createTestUser(prisma);
  const trashCollectionId = `trash:${testUser.id}`;

  const trash = await prisma.collection.findFirst({
    where: { id: trashCollectionId, userId: testUser.id },
  });
  if (!trash) {
    await prisma.collection.create({
      data: { id: trashCollectionId, name: "Trash", userId: testUser.id },
    });
  }

  return testUser;
};

/**
 * Generate a sample base64 PNG image data URL
 * This creates a small but valid PNG for testing
 */
const generateSampleImageDataUrl = (size: "small" | "medium" | "large" = "small"): string => {
  const smallPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

  if (size === "small") {
    return `data:image/png;base64,${smallPng}`;
  }

  const repetitions = size === "medium" ? 1000 : 10000;
  const paddedBase64 = smallPng.repeat(repetitions);

  return `data:image/png;base64,${paddedBase64}`;
};

/**
 * Generate a large image data URL that exceeds the 10000 char limit
 * This is specifically designed to catch the truncation bug from issue #17
 */
export const generateLargeImageDataUrl = (): string => {
  const baseImage =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const largeBase64 = baseImage.repeat(500);
  return `data:image/png;base64,${largeBase64}`;
};

/**
 * Create a sample Excalidraw files object with embedded images
 */
export const createSampleFilesObject = (
  imageCount: number = 1,
  size: "small" | "large" = "small",
) => {
  const files: Record<string, any> = {};

  for (let i = 0; i < imageCount; i++) {
    const fileId = `file-${i}-${Date.now()}`;
    files[fileId] = {
      id: fileId,
      mimeType: "image/png",
      dataURL: size === "large" ? generateLargeImageDataUrl() : generateSampleImageDataUrl("small"),
      created: Date.now(),
      lastRetrieved: Date.now(),
    };
  }

  return files;
};

/**
 * Create a minimal valid Excalidraw drawing payload
 */
export const createTestDrawingPayload = (
  options: {
    name?: string;
    files?: Record<string, any> | null;
    elements?: any[];
    appState?: any;
  } = {},
) => {
  return {
    name: options.name ?? "Test Drawing",
    elements: options.elements ?? [
      {
        id: "element-1",
        type: "rectangle",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        angle: 0,
        strokeColor: "#000000",
        backgroundColor: "transparent",
        fillStyle: "hachure",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 12345,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
      },
    ],
    appState: options.appState ?? {
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
    files: options.files ?? null,
    preview: null,
    collectionId: null,
  };
};

/**
 * Compare two files objects to check if image data was preserved
 */
export const compareFilesObjects = (
  original: Record<string, any>,
  received: Record<string, any>,
): {
  isEqual: boolean;
  differences: string[];
} => {
  const differences: string[] = [];

  const originalKeys = Object.keys(original);
  const receivedKeys = Object.keys(received);

  if (originalKeys.length !== receivedKeys.length) {
    differences.push(
      `Key count mismatch: original=${originalKeys.length}, received=${receivedKeys.length}`,
    );
  }

  for (const key of originalKeys) {
    if (!(key in received)) {
      differences.push(`Missing key: ${key}`);
      continue;
    }

    const origFile = original[key];
    const recvFile = received[key];

    if (origFile.dataURL !== recvFile.dataURL) {
      differences.push(
        `DataURL mismatch for ${key}: ` +
          `original length=${origFile.dataURL?.length ?? 0}, ` +
          `received length=${recvFile.dataURL?.length ?? 0}`,
      );

      if (recvFile.dataURL && origFile.dataURL?.startsWith(recvFile.dataURL.substring(0, 100))) {
        differences.push(`TRUNCATION DETECTED: dataURL was cut short`);
      }
    }
  }

  return {
    isEqual: differences.length === 0,
    differences,
  };
};
