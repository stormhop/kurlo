---
title: "Import WSDL for SOAP"
description: Build SOAP 1.1 and 1.2 requests with sample envelopes from a WSDL 1.1 file or URL.
---

Select **WSDL / SOAP** in **Import collection**, click **Import**, and choose a `.wsdl` or `.xml` file. You can also drop the file onto the window. Kurlo builds a collection with one HTTP request for every operation of every SOAP port.

To import from a running service, select **WSDL from URL**, paste a link such as `https://example.com/Service.svc?wsdl` and click **Import**. Kurlo fetches the document itself, so redirects are followed and your proxy settings apply. Tick **Skip TLS certificate check** only for a server you trust that uses a self-signed or internal certificate.

## Imported WSDL and schema files

Many services split their description over several files. WCF's `?wsdl`, for example, imports `?wsdl=wsdl0`, which imports its schemas from `?xsd=xsd0`. Kurlo follows `wsdl:import`, `xsd:import` and `xsd:include`:

- From a URL, Kurlo fetches each imported address, relative to the document that imports it. When a server redirects, addresses are relative to where the document was finally served from. Only `http` and `https` addresses are fetched.
- From a file, Kurlo reads imported files relative to that file, so keep them in the same folder structure.

If an imported file cannot be loaded, the import stops and names the file. A WSDL imported without a path, for example from the browser file picker, cannot follow imports: elements from those files get `?`, and the toast says how many files were not found.

## What each request contains

| Part | Value |
|---|---|
| Name | The operation name |
| Method and URL | `POST` to the port's `soap:address` |
| Headers | SOAP 1.1: `Content-Type: text/xml; charset=utf-8` and `SOAPAction`. SOAP 1.2: `Content-Type: application/soap+xml; charset=utf-8; action="…"` |
| WS-Addressing | When the binding or its policy declares WS-Addressing, as WCF's `wsHttpBinding` does, `soap:Header` gets `wsa:Action` and `wsa:To` |
| Body | An XML envelope for the input message |
| Docs | The operation's documentation, the SOAP version and the service and port |

A service that offers the same operations over SOAP 1.1 and SOAP 1.2, as .NET services do, gets one folder per port. A WSDL with several services gets a folder for each service and port. Ports with an HTTP GET or POST binding are skipped.

The collection is named after the `name` of `wsdl:definitions`, or the service when there is one, or the file name.

## Sample envelopes

Kurlo builds the body from the XML Schema in `wsdl:types`:

- `document` style puts the elements of the message parts in `soap:Body`. `rpc` style wraps the parts in an element named after the operation, in the namespace of `soap:body`.
- Parts listed in `soap:header` go into `soap:Header`.
- Elements and attributes get sample values by type: `?` for strings, `0` for numbers, `false` for booleans, a date for dates. A `default` or `fixed` value, or the first enumeration value, wins.
- Optional elements are marked with `<!--Optional:-->`. For a choice, Kurlo writes the first option and lists the others in a comment.
- Repeated elements appear once. A type that contains itself stops after one nested level.
- Namespace prefixes come from the WSDL, and elements are qualified as `elementFormDefault` and `form` say.

Replace the sample values and send the request. The response opens as XML.

## Limits

- Only WSDL 1.1 is read. A WSDL 2.0 document is rejected with a message.
- Kurlo stops after 100 imported files.
- SOAP-encoded `rpc` bodies are written without `xsi:type` attributes.
- WS-Security headers and WS-Addressing headers other than `Action` and `To`, such as `MessageID` and `ReplyTo`, are not generated. Add them to the envelope yourself.
