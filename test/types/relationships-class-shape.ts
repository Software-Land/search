/**
 * search-relationships RelationshipError must remain a class declaration:
 * constructible, instanceof-compatible, extensible, and usable as value+type.
 */
import { RelationshipError, compileRelationships } from "@software-land/search/relationships";

class DerivedRelationshipError extends RelationshipError {}

const e = new RelationshipError("bad domain relationships");
const derived = new DerivedRelationshipError("derived");
const RelationshipErrorConstructor = RelationshipError;
const constructedFromAlias = new RelationshipErrorConstructor("aliased");

const isRelationshipError = e instanceof RelationshipError;
const isError = e instanceof Error;
const isDerived = derived instanceof RelationshipError;

const asType: RelationshipError = e;
const message: string = asType.message;
const details: string[] | undefined = asType.details;

void compileRelationships;
void constructedFromAlias;
void isRelationshipError;
void isError;
void isDerived;
void message;
void details;
void typeof RelationshipError;
void new DerivedRelationshipError("derived");
void new RelationshipError();
