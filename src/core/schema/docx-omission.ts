/** One omitted external resource relationship. Part name + rId + public Type category — never the Target URL. */
export interface DocxOmittedExternalRef {
  /** Relationship part it lived in, e.g. 'word/_rels/footer1.xml.rels'. */
  part: string;
  /** Relationship Id (e.g. 'rId2'). */
  relationshipId: string;
  /** Relationship Type URI last segment, lowercased (e.g. 'image', 'attachedtemplate') — a public schema constant. */
  relationshipType: string;
}
