import { run } from "./runQuirrel";
import fastify, { FastifyInstance } from "fastify";
import delay from "delay";
import type * as http from "http";
import * as request from "supertest";
import { Redis } from "ioredis";

describe("jobs", () => {
  let quirrel: http.Server;
  let teardown: () => Promise<void>;

  let server: FastifyInstance;
  let redis: Redis;
  let endpoint: string;
  let bodies: any[] = [];
  let lastBody: any = undefined;

  beforeAll(async () => {
    const result = await run();
    quirrel = result.server;
    teardown = result.teardown;
    redis = result.redis;

    await result.redis.flushall();

    const server = fastify();
    server.post("/", (request, reply) => {
      lastBody = request.body;
      bodies.push(lastBody);
      reply.status(200).send("OK");
    });

    endpoint = encodeURIComponent(await server.listen(0));
  });

  beforeEach(async () => {
    bodies = [];
    lastBody = undefined;
    await redis.flushall();
  });

  afterAll(async () => {
    await Promise.all([teardown(), server.close()]);
  });

  test("post a job", async () => {
    await request(quirrel)
      .post("/queues/" + endpoint)
      .send({ body: { foo: "bar" } })
      .expect(201);

    await delay(300);

    expect(lastBody).toEqual('{"foo":"bar"}');
  });

  describe("retrieve delayed jobs", () => {
    test("all", async () => {
      const {
        body: { id: jobId1 },
      } = await request(quirrel)
        .post("/queues/" + endpoint)
        .send({
          body: { this: "willBeRetrieved", nr: 1 },
          runAt: new Date(Date.now() + 300).toISOString(),
        })
        .expect(201);

      const {
        body: { id: jobId2 },
      } = await request(quirrel)
        .post("/queues/" + endpoint)
        .send({
          body: { this: "willBeRetrieved", nr: 2 },
          runAt: new Date(Date.now() + 300).toISOString(),
        })
        .expect(201);

      const {
        body: { cursor, jobs },
      } = await request(quirrel).get(`/queues/${endpoint}`).expect(200);

      expect(cursor).toBe(null);
      const jobsWithoutRunAt = jobs.map(
        ({ runAt, ...restOfJob }: { runAt: string }) => restOfJob
      );

      expect(jobsWithoutRunAt).toHaveLength(2);

      expect(jobsWithoutRunAt).toContainEqual({
        id: jobId1,
        body: {
          nr: 1,
          this: "willBeRetrieved",
        },
        endpoint: decodeURIComponent(endpoint),
      });
      expect(jobsWithoutRunAt).toContainEqual({
        id: jobId2,
        body: {
          nr: 2,
          this: "willBeRetrieved",
        },
        endpoint: decodeURIComponent(endpoint),
      });

      await request(quirrel)
        .delete(`/queues/${endpoint}/${jobId1}`)
        .expect(200);
      await request(quirrel)
        .delete(`/queues/${endpoint}/${jobId2}`)
        .expect(200);
    });

    test("by id", async () => {
      const runAt = new Date(Date.now() + 300).toISOString();
      const {
        body: { id },
      } = await request(quirrel)
        .post("/queues/" + endpoint)
        .send({
          body: { this: "willBeRetrieved" },
          runAt,
        })
        .expect(201);

      const { body: job } = await request(quirrel)
        .get(`/queues/${endpoint}/${id}`)
        .expect(200);

      const { runAt: jobRunAt, ...restOfJob } = job;

      expect(restOfJob).toEqual({
        id,
        body: { this: "willBeRetrieved" },
        endpoint: decodeURIComponent(endpoint),
      });

      expect(+new Date(jobRunAt)).toBeCloseTo(+new Date(runAt), -3);

      await request(quirrel).delete(`/queues/${endpoint}/${id}`).expect(200);
    });
  });

  test("post a delayed job", async () => {
    await request(quirrel)
      .post("/queues/" + endpoint)
      .send({
        body: { lol: "lel" },
        runAt: new Date(Date.now() + 300).toISOString(),
      })
      .expect(201);

    await delay(150);

    expect(lastBody).not.toEqual('{"lol":"lel"}');

    await delay(300);

    expect(lastBody).toEqual('{"lol":"lel"}');
  });

  test("delete a job before it's executed", async () => {
    const { body } = await request(quirrel)
      .post("/queues/" + endpoint)
      .send({
        body: { iWill: "beDeleted" },
        runAt: new Date(Date.now() + 300).toISOString(),
      })
      .expect(201);

    expect(typeof body.id).toBe("string");

    await request(quirrel).delete(`/queues/${endpoint}/${body.id}`).expect(200);

    await delay(500);

    expect(lastBody).not.toEqual('{"iWill":"beDeleted"}');
  });

  test("idempotent jobs", async () => {
    const id = "sameIdAcrossBothJobs";

    const {
      body: { id: jobId1 },
    } = await request(quirrel)
      .post("/queues/" + endpoint)
      .send({
        body: { iAm: "theFirstJob" },
        runAt: new Date(Date.now() + 300).toISOString(),
        id,
      })
      .expect(201);

    expect(jobId1).toEqual(id);

    const {
      body: { id: jobId2 },
    } = await request(quirrel)
      .post("/queues/" + endpoint)
      .send({
        body: { iAm: "theSecondJob" },
        runAt: new Date(Date.now() + 300).toISOString(),
        id,
      })
      .expect(201);

    expect(jobId2).toEqual(id);

    await delay(400);

    expect(bodies).toEqual(['{"iAm":"theFirstJob"}']);

    const {
      body: { id: jobId3 },
    } = await request(quirrel)
      .post("/queues/" + endpoint)
      .send({
        body: { iAm: "theSecondJob" },
        runAt: new Date(Date.now() + 300).toISOString(),
        id,
      })
      .expect(201);

    expect(jobId3).toEqual(id);

    await delay(500);

    expect(bodies).toEqual(['{"iAm":"theFirstJob"}', '{"iAm":"theSecondJob"}']);
  });
});
