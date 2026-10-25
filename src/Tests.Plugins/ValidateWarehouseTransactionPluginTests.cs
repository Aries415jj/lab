using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using FakeXrmEasy.Plugins;
using Plugins.Warehouse;

namespace Tests.Plugins
{
    [TestClass]
    public class ValidateWarehouseTransactionPluginTests : FakeXrmEasyTestBase
    {
        private const int Inbound = 100000000;
        private const int Outbound = 100000001;

        private Entity SeedItem(int available)
        {
            var item = new Entity("lab_warehouseitem") { Id = Guid.NewGuid() };
            item["lab_availablequantity"] = available;
            _context.Initialize(new[] { item });
            return item;
        }

        private Entity MakeTransaction(Guid itemId, int quantity, int type)
        {
            var transaction = new Entity("lab_warehousetransaction") { Id = Guid.NewGuid() };
            transaction["lab_quantity"] = quantity;
            transaction["lab_itemid"] = new EntityReference("lab_warehouseitem", itemId);
            transaction["lab_transactiontype"] = new OptionSetValue(type);
            return transaction;
        }

        private void Execute(Entity target)
        {
            var pluginContext = _context.GetDefaultPluginContext();
            pluginContext.MessageName = "Create";
            pluginContext.PrimaryEntityName = "lab_warehousetransaction";
            pluginContext.InputParameters["Target"] = target;

            var plugin = new ValidateWarehouseTransactionPlugin(string.Empty, string.Empty);
            _context.ExecutePluginWith(pluginContext, plugin);
        }

        [TestMethod]
        public void Outbound_With_Enough_Stock_Does_Not_Throw()
        {
            var item = SeedItem(available: 10);

            Execute(MakeTransaction(item.Id, quantity: 3, Outbound));

            var reloaded = _service.Retrieve("lab_warehouseitem", item.Id, new ColumnSet("lab_availablequantity"));
            Assert.AreEqual(10, reloaded.GetAttributeValue<int>("lab_availablequantity"));
        }

        [TestMethod]
        public void Outbound_With_Too_High_Quantity_Throws()
        {
            var item = SeedItem(available: 5);

            var ex = Assert.ThrowsExactly<InvalidPluginExecutionException>(
                () => Execute(MakeTransaction(item.Id, quantity: 10, Outbound)));

            StringAssert.Contains(ex.Message, "Not enough product in stock");
            StringAssert.Contains(ex.Message, "Available: 5");
            StringAssert.Contains(ex.Message, "requested: 10");
        }

        [TestMethod]
        public void Inbound_Is_Not_Validated()
        {
            var item = SeedItem(available: 0);

            // Inbound transactions add stock, so quantity above availability is fine.
            Execute(MakeTransaction(item.Id, quantity: 100, Inbound));
        }
    }
}
