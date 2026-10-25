const core = require(process.env.JETS_CORE);

const { makeAttr, makeLookup, makeForm, makeExecutionContext } = core;
const { loadWebResource } = require('./utils/loadWebRes');

beforeAll(() => core.setupXrm());

beforeEach(() => {
  core.resetXrmMocks();
  Xrm.WebApi.retrieveRecord = jest.fn();
});

test('onLoad defaults transaction date to today when empty', () => {
  const { WarehouseScripts } = loadWebResource(process.env.WEBRES_PATH);
  const dateAttr = makeAttr(null);
  const form = makeForm({ 'lab_transactiondate': dateAttr });

  WarehouseScripts.TransactionForm.onLoad(makeExecutionContext(form));

  expect(dateAttr.setValue).toHaveBeenCalledTimes(1);
  const value = dateAttr.setValue.mock.calls[0][0];
  expect(typeof value.getTime).toBe('function');
});

test('onLoad keeps an already filled transaction date', () => {
  const { WarehouseScripts } = loadWebResource(process.env.WEBRES_PATH);
  const dateAttr = makeAttr('2026-01-01');
  const form = makeForm({ 'lab_transactiondate': dateAttr });

  WarehouseScripts.TransactionForm.onLoad(makeExecutionContext(form));

  expect(dateAttr.setValue).not.toHaveBeenCalled();
});

test('onQuantityChange recalculates total value from unit price', async () => {
  const { WarehouseScripts } = loadWebResource(process.env.WEBRES_PATH);
  const totalAttr = makeAttr(null);
  const form = makeForm({
    'lab_quantity': makeAttr(4),
    'lab_itemid': makeLookup({
      id: '{e3588fd9-c98c-4c13-9b75-5ff09688b468}',
      entityType: 'lab_warehouseitem',
      name: 'Item A'
    }),
    'lab_totalvalue': totalAttr
  });
  Xrm.WebApi.retrieveRecord.mockResolvedValue({ lab_unitprice: 25 });

  await WarehouseScripts.TransactionForm.onQuantityChange(makeExecutionContext(form));

  expect(Xrm.WebApi.retrieveRecord).toHaveBeenCalledWith(
    'lab_warehouseitem',
    'e3588fd9-c98c-4c13-9b75-5ff09688b468',
    '?$select=lab_unitprice'
  );
  expect(totalAttr.setValue).toHaveBeenCalledWith(100);
});
