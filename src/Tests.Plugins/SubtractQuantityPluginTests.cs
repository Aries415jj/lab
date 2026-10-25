using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using FakeXrmEasy.Plugins;
using Plugins.Warehouse;

namespace Tests.Plugins
{
    [TestClass]
    public class SubtractQuantityPluginTests : FakeXrmEasyTestBase
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

        private void Execute(Guid itemId, int quantity, int type)
        {
            var transaction = new Entity("lab_warehousetransaction") { Id = Guid.NewGuid() };
            transaction["lab_quantity"] = quantity;
            transaction["lab_itemid"] = new EntityReference("lab_warehouseitem", itemId);
            transaction["lab_transactiontype"] = new OptionSetValue(type);

            var pluginContext = _context.GetDefaultPluginContext();
            pluginContext.MessageName = "Create";
            pluginContext.PrimaryEntityName = "lab_warehousetransaction";
            pluginContext.InputParameters["Target"] = transaction;

            var plugin = new SubtractQuantityPlugin(string.Empty, string.Empty);
            _context.ExecutePluginWith(pluginContext, plugin);
        }

        private int AvailableQuantity(Guid itemId) =>
            _service.Retrieve("lab_warehouseitem", itemId, new ColumnSet("lab_availablequantity"))
                .GetAttributeValue<int>("lab_availablequantity");

        [TestMethod]
        public void Outbound_Subtracts_Quantity_From_Item()
        {
            var item = SeedItem(available: 10);

            Execute(item.Id, quantity: 3, Outbound);

            Assert.AreEqual(7, AvailableQuantity(item.Id));
        }

        [TestMethod]
        public void Inbound_Adds_Quantity_To_Item()
        {
            var item = SeedItem(available: 10);

            Execute(item.Id, quantity: 5, Inbound);

            Assert.AreEqual(15, AvailableQuantity(item.Id));
        }
    }
}
