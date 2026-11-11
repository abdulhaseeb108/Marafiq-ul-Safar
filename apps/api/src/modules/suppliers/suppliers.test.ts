import { SupplierViewSchema } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, makeApp, seedSupplier, seedUser, signInAs } from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { SupplierModel } from './supplier.model.js';

const URL = '/api/v1/admin/suppliers';

describe('suppliers', () => {
  let app: Express;
  let jar: CookieJar;
  let actorId: string;

  beforeEach(async () => {
    app = makeApp().app;
    const ops = await seedUser({ role: 'ops' });
    actorId = ops.id;
    jar = await signInAs(app, ops);
  });

  it('creates a supplier and trims text', async () => {
    const res = await request(app).post(URL).set('Cookie', jar.header()).send({
      name: '  Waqar-e-Madina Group (WMT)  ',
      type: 'hotel_operator',
      contactName: 'Mr Waqar',
      phone: '+92 51 000 0000',
      email: 'rates@example.com',
    });

    expect(res.status).toBe(201);
    const supplier = SupplierViewSchema.parse(res.body);
    expect(supplier.name).toBe('Waqar-e-Madina Group (WMT)');
    expect(supplier.active).toBe(true);
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(SupplierViewSchema.shape).sort());
  });

  it('rejects an empty name, an unknown type and a malformed email', async () => {
    const noName = await request(app)
      .post(URL)
      .set('Cookie', jar.header())
      .send({ name: '   ', type: 'hotel_operator' });
    expect(noName.status).toBe(400);
    expect(noName.body.error.fields).toHaveProperty('name');

    const badType = await request(app)
      .post(URL)
      .set('Cookie', jar.header())
      .send({ name: 'A', type: 'airline' });
    expect(badType.status).toBe(400);

    const badEmail = await request(app)
      .post(URL)
      .set('Cookie', jar.header())
      .send({ name: 'A', type: 'other', email: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.fields).toHaveProperty('email');
  });

  it('rejects a duplicate name', async () => {
    await seedSupplier({ name: 'Waqar-e-Madina Group (WMT)' });
    const res = await request(app)
      .post(URL)
      .set('Cookie', jar.header())
      .send({ name: 'waqar-e-madina group (wmt)', type: 'hotel_operator' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('supplier_name_taken');
  });

  it('lists suppliers with paging', async () => {
    await seedSupplier();
    await seedSupplier();
    const res = await request(app).get(`${URL}?limit=1`).set('Cookie', jar.header());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(res.body.items).toHaveLength(1);
  });

  it('updates a supplier', async () => {
    const supplier = await seedSupplier({ name: 'Old Name' });
    const res = await request(app)
      .patch(`${URL}/${supplier.id}`)
      .set('Cookie', jar.header())
      .send({ name: 'New Name', notes: 'Sends sheets on WhatsApp' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'New Name', notes: 'Sends sheets on WhatsApp' });
  });

  it('deactivates instead of deleting, and can reactivate', async () => {
    const supplier = await seedSupplier();
    const off = await request(app)
      .post(`${URL}/${supplier.id}/deactivate`)
      .set('Cookie', jar.header());
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    expect(await SupplierModel.countDocuments({ _id: supplier.id })).toBe(1);

    const hardDelete = await request(app)
      .delete(`${URL}/${supplier.id}`)
      .set('Cookie', jar.header());
    expect(hardDelete.status).toBe(404);
    expect(await SupplierModel.countDocuments({ _id: supplier.id })).toBe(1);

    const on = await request(app)
      .patch(`${URL}/${supplier.id}`)
      .set('Cookie', jar.header())
      .send({ active: true });
    expect(on.body.active).toBe(true);
  });

  it('returns 404 for unknown and malformed ids', async () => {
    expect(
      (await request(app).get(`${URL}/64b7f0c2a1b2c3d4e5f60718`).set('Cookie', jar.header()))
        .status,
    ).toBe(404);
    expect((await request(app).get(`${URL}/nope`).set('Cookie', jar.header())).status).toBe(404);
  });

  it('audits create, update and deactivate with before and after', async () => {
    const created = await request(app)
      .post(URL)
      .set('Cookie', jar.header())
      .set('X-Forwarded-For', '203.0.113.5')
      .send({ name: 'Audited Supplier', type: 'transport' });
    const id = created.body.id as string;
    await request(app).patch(`${URL}/${id}`).set('Cookie', jar.header()).send({ name: 'Renamed' });
    await request(app).post(`${URL}/${id}/deactivate`).set('Cookie', jar.header());

    const events = await AuditEventModel.find({ entityType: 'supplier' }).sort({ at: 1 }).lean();
    expect(events.map((e) => e.action)).toEqual([
      'supplier.create',
      'supplier.update',
      'supplier.deactivate',
    ]);
    expect(String(events[0]?.actorId)).toBe(actorId);
    expect(events[0]?.actorRole).toBe('ops');
    expect(events[0]?.ip).toBe('203.0.113.5');
    expect(events[0]?.after).toMatchObject({ name: 'Audited Supplier', active: true });
    expect(events[1]?.before).toMatchObject({ name: 'Audited Supplier' });
    expect(events[1]?.after).toMatchObject({ name: 'Renamed' });
    expect(events[2]?.after).toMatchObject({ active: false });
  });
});
