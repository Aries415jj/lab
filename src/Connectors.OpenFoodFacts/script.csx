// Custom code for the connector - implements Microsoft's "Script : ScriptBase" contract.
// Docs: https://learn.microsoft.com/en-us/connectors/custom-connectors/write-code
//
// Routed by Context.OperationId (scriptOperations is left empty in apiProperties.json, so
// this script runs for every operation):
//
//   GetProductByBarcode - adds the User-Agent header the backend requires, and flattens the
//     backend's nested, snake_case response into this connector's declared Product schema.
//
//   GetProductImage - proxies an image's bytes server-side, since a code app's CSP can block
//     loading an external image URL client-side. The image's host differs from the backend's
//     declared host, so the outgoing request's URI is redirected to it before sending.
//
// Runs on .NET Standard 2.0 with a restricted namespace set - see the doc above for the full
// list. Execution must finish within 2 minutes; the compiled script can't exceed 1 MB.

using System;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

public class Script : ScriptBase
{
    private const string UserAgent = "TALXIS-Lab-WarehousePicking/1.0 (+https://github.com/TALXIS/lab)";
    private const string ApprovedImageHost = "images.openfoodfacts.org";
    private const int MaxImageRedirects = 3;

    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        if (string.Equals(this.Context.OperationId, "GetProductImage", StringComparison.OrdinalIgnoreCase))
        {
            return await GetProductImageAsync().ConfigureAwait(false);
        }

        return await GetProductByBarcodeAsync().ConfigureAwait(false);
    }

    private async Task<HttpResponseMessage> GetProductByBarcodeAsync()
    {
        this.Context.Request.Headers.UserAgent.ParseAdd(UserAgent);

        var response = await this.Context.SendAsync(this.Context.Request, this.CancellationToken)
            .ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            return response;
        }

        var body = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));

        // Open Food Facts returns HTTP 200 with status:0 for an unknown barcode - it isn't a
        // transport-level error, but there's no product to flatten either. Surface it as 404
        // so the caller's error handling matches every other "not found" connector call.
        if ((int?)body["status"] != 1)
        {
            response.StatusCode = HttpStatusCode.NotFound;
            response.Content = CreateJsonContent("{\"message\": \"No product found for this barcode\"}");
            return response;
        }

        var product = body["product"];
        var flattened = new JObject
        {
            ["ean"] = (string)body["code"],
            ["name"] = (string)product["product_name"],
            ["brand"] = (string)product["brands"],
            ["quantity"] = (string)product["quantity"],
            ["imageUrl"] = (string)product["image_url"]
        };
        response.Content = CreateJsonContent(flattened.ToString());

        return response;
    }

    private async Task<HttpResponseMessage> GetProductImageAsync()
    {
        var imageUrl = GetQueryParameter(this.Context.Request.RequestUri, "imageUrl");
        if (string.IsNullOrEmpty(imageUrl))
        {
            return CreateImageError(HttpStatusCode.BadRequest, "imageUrl query parameter is required");
        }

        if (!Uri.TryCreate(imageUrl, UriKind.Absolute, out var imageUri) || !IsApprovedImageUri(imageUri))
        {
            return CreateImageError(HttpStatusCode.BadRequest,
                "Only HTTPS image URLs from approved Open Food Facts image hosts are allowed");
        }

        var requestUri = imageUri;
        for (var redirectCount = 0; redirectCount <= MaxImageRedirects; redirectCount++)
        {
            var outgoingRequest = new HttpRequestMessage(HttpMethod.Get, requestUri);
            outgoingRequest.Headers.UserAgent.ParseAdd(UserAgent);
            foreach (var acceptHeader in this.Context.Request.Headers.Accept)
            {
                outgoingRequest.Headers.Accept.Add(acceptHeader);
            }

            var response = await this.Context.SendAsync(outgoingRequest, this.CancellationToken)
                .ConfigureAwait(false);

            var responseUri = response.RequestMessage?.RequestUri;
            if (!IsApprovedImageUri(responseUri))
            {
                response.Dispose();
                outgoingRequest.Dispose();
                return CreateImageError(HttpStatusCode.BadGateway,
                    "Image URL redirected to an unapproved Open Food Facts image host");
            }

            var statusCode = (int)response.StatusCode;
            if (statusCode < 300 || statusCode > 399)
            {
                return response;
            }

            if (redirectCount == MaxImageRedirects || response.Headers.Location == null)
            {
                response.Dispose();
                outgoingRequest.Dispose();
                return CreateImageError(HttpStatusCode.BadGateway, "Image URL returned an unsafe or excessive redirect");
            }

            var redirectUri = response.Headers.Location.IsAbsoluteUri
                ? response.Headers.Location
                : new Uri(responseUri, response.Headers.Location);
            if (!IsApprovedImageUri(redirectUri))
            {
                response.Dispose();
                outgoingRequest.Dispose();
                return CreateImageError(HttpStatusCode.BadGateway,
                    "Image URL redirected to an unapproved Open Food Facts image host");
            }

            response.Dispose();
            outgoingRequest.Dispose();
            requestUri = redirectUri;
        }

        return CreateImageError(HttpStatusCode.BadGateway, "Image URL returned too many redirects");
    }

    private static bool IsApprovedImageUri(Uri uri)
    {
        return uri != null &&
            uri.IsAbsoluteUri &&
            string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) &&
            uri.IsDefaultPort &&
            string.IsNullOrEmpty(uri.UserInfo) &&
            string.IsNullOrEmpty(uri.Fragment) &&
            string.Equals(uri.IdnHost, ApprovedImageHost, StringComparison.OrdinalIgnoreCase);
    }

    private static HttpResponseMessage CreateImageError(HttpStatusCode statusCode, string message)
    {
        var response = new HttpResponseMessage(statusCode);
        response.Content = CreateJsonContent(new JObject { ["message"] = message }.ToString());
        return response;
    }

    // System.Web.HttpUtility isn't in the custom-code namespace allowlist, so query strings are
    // parsed by hand here instead.
    private static string GetQueryParameter(Uri requestUri, string name)
    {
        var query = requestUri.Query.TrimStart('?');
        if (string.IsNullOrEmpty(query))
        {
            return null;
        }

        foreach (var pair in query.Split('&'))
        {
            var parts = pair.Split(new[] { '=' }, 2);
            if (parts.Length == 2 && parts[0] == name)
            {
                return Uri.UnescapeDataString(parts[1]);
            }
        }

        return null;
    }
}

