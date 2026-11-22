const { DOMParser, onWarningStopParsing } = require("@xmldom/xmldom");

function xmlRoot(xml, element) {
  if (typeof xml !== "string" || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error(`Invalid ${element} XML or forbidden document type.`);
  }
  const root = new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    xml,
    "application/xml",
  ).documentElement;
  if (root.tagName !== element) throw new Error(`Expected <${element}> XML.`);
  return root;
}

function elements(node, name) {
  return Array.from(node?.childNodes ?? []).filter(
    (child) => child.nodeType === 1 && (!name || child.tagName === name),
  );
}

function child(node, name) {
  const matches = elements(node, name);
  if (matches.length > 1) throw new Error(`Unexpected duplicate <${name}>.`);
  return matches[0];
}

function value(node, name) {
  const element = child(node, name);
  if (elements(element).length) throw new Error(`Expected text in <${name}>.`);
  return element?.textContent.trim();
}

module.exports = { child, elements, value, xmlRoot };
