Polynar
=

Polynar is an easy to use encoding library for Javascript, utilizing polynary numbers for efficient and dynamic data storage, while even rivaling binary when similar storage is utilized.
Be aware that this is by no means a way of encryption, encoded data can easily be recovered even without knowledge of the applied encoding options.
		
Most data storage tools either force your to either settle for data limits equal to a power of two, making you waste twice as much space when it barely doesn't fit, or use an obscene amount of space when you already have to figure out a proper way of composing and parsing your data (Base64). Polynar removes all these limitations by using its own algorithm to store data by exactly the limits you supply it, massively limiting the amount of storage space wasted and even taking away the need to compose and parse your own data.

### Usage

The library can be utilized by adding it your project, either by use of the SCRIPT tag in a web environment or through require in NodeJS.
Adding the library to your project creates a Polynar object (by default assigned to the variable 'Polynar'), from which all functionality stems.

### Examples

[JSFiddle Object Encoding/Decoding Example](http://jsfiddle.net/Phaen/JWHt5/)

[JSFiddle Misc. Data Encoding/Decoding Example](http://jsfiddle.net/Phaen/VetvQ/)

Documentation
=

**Encoding**
* [.encoder](#encoder)
* [.encoder.write](#encoderwrite)
* [.encoder.compose](#encodercompose)
* [.encoder.toString](#encodertostring)

**Decoding**
* [.decoder](#decoder)
* [.decoder.read](#decoderread)
* [.decoder.parse](#decoderparse)

**Miscellaneous**
* [The encodingOptions object](#the-encodingoptions-object)
* [Character sets](#character-sets)


###.encoder
> ```Javascript
var encoder = new Polynar.encoder();
```

Creates an encoder instance to which the data can be written. When not called as a constructor, it will do so itself instead and return the newly created instance. It accepts no arguments.

###.encoder.write
> ```Javascript
encoder.write( items, encodingOptions );
```

The method used for writing any kind of data to the encoder instance. It takes two arguments.

* **items** <br/> The item or array of items to write, must be compliant with the encoding options.
* **encodingOptions** <br/> An [encodingOptions object](#encodingoptions), specifying the encoding options to encode the items with.

When encoding data, it is important to know that order matters. You must write the data in the exact same order, using the exact same options as it will be read. The best way to do this is to predefine all [encodingOptions objects](#encodingoptions) you will use and refer to the same ones in both your encoding and decoding algorithm.

###.encoder.compose
> ```Javascript
encoder.compose( integer, radix );
```

The underlaying method used by *encoder.write*. It accepts two arguments.

* **integer** <br/> The unsigned integer to encode.
* **radix** <br/> The radix to encode the integer under.

No sanitizing is utilized and using this method can improve efficiency, but is discouraged when lacking expertise. When used improperly, the encoding process may raise exceptions or produce corrupt data.

###.encoder.toString
> ```Javascript
encoder.compose( charset );
```

The method to return the encoded data as string. It accepts one argument.

* **charset** <br/> The [character set](#character-sets) to output the encoded data under.

Because of the naming convention, an encoder instance will automatically return the encoded data whenever it is cast to string.

Be aware that byte size is an exponential function of the bit count, resulting in diminishing returns. Having a massive set is only a small advantage in string length over a large set.

###.decoder
> ```Javascript
var decoder = new Polynar.decoder( data, charset );
```

Returns a decoder instance from which the data can be read. When not called as a constructor, it will do so itself instead and return the newly created instance. It accepts two arguments.

* **data** <br/> The encoded data string to decode.
* **charset** <br/>  The [character set](#character-sets) under which to interpret the encoded data.

Be aware that the encoded data fed to the decoder needs to be the exact same as was output by the encoder, no trailing spaces are allowed as they could all be part of the data.

###.decoder.read
> ```Javascript
decoder.read( encodingOptions [, count ] );
```

The method used for reading any kind of data from the decoder instance. It accepts two arguments.

* **encodingOptions** <br/> An [encodingOptions object](#encodingoptions), specifying the encoding options to decode the items with.
* **count** (optional) <br/> A positive integer with the amount of items to decode, will be ignored if the *limit* encoding option is set.

When decoding data, it is important to know that order matters. You must read the data in the exact same order, using the exact same options as it was previously written. The best way to do this is to predefine all [encodingOptions objects](#encodingoptions) you will use and refer to the same ones in both your encoding and decoding algorithm.

###.decoder.parse
> ```Javascript
encoder.compose( integer, radix );
```

The underlaying method used by *decoder.read*. It parses and returns an integer. It accepts one argument.

* **radix** <br/> The radix to decode the integer from.

No sanitizing is utilized and using this method can improve efficiency, but is discouraged when lacking expertise. When used improperly, the decoding process may raise exceptions or produce corrupt data.

###The encodingOptions object
EncodingOptions is a plainObject containing the options as property-value pairs to be used in encoding and decoding processes. These options differ per data type that is encoded.

##### Numbers

* **type** *(string)* <br/> Must be set to *'number'*.
* **min** *(integer)* <br/> The lower bound of the range.
* **max** *(integer)* <br/> The upper bound of the range.
* **offset** *(integer, optional)* <br/> Alternatively specifies the range through the maximum offset from zero, will overwrite min and max.
* **step** *(unsigned float, optional)* <br/> The step size of the range, will default to *1*.

Despite their naming convention, *min* and *max* can accept either range bound.

##### Strings

* **type** *(string)* <br/> Must be set to *'string'*.
* **max** *(unsigned integer)* <br/> The maximum amount of characters in a string.
* **charset** *([character set](#character-sets))* <br/> The [character set](#character-sets) of the string.

##### Booleans

* **type** *(string)* <br/> Must be set to 'boolean'.

##### Items by list

By supplying a list, any kind of item that appears in that list can be processed.

* **type** *(string)* <br/> Must be set to *'item'*.
* **list** *(array)* <br/> The list containing all items that can be processed, it cannot be empty.
* **sort** *(bool, optional)* <br/> If *true*, will sort the list before encoding ensuring that identical, but differently ordered lists will yield the same results. Will default to *false*.

Be aware that items that are arrays must be supplied in a containing array at all times, regardless whether only one is supplied. Otherwise your item's contents will be mistaken for seperate items instead.

##### Objects

Whole objects can be processed as well, allowing you to furfill most of your encoding and decoding needs through one function call.

* **type** *(string)* <br/> Must be set to *'object'*.
* **template** *(plainObject)* <br/> A plainObject containing all properties of the object to be processed and the [encodingOptions objects](#encodingoptions) to process them under as property-value pairs. Instead of supplying nested options, the template will be parsed recursively and can also contain nested objects.
* **base** *(object/function, optional)* Decoding only. The object or object retrieved from function to assign the data to. If ommitted, an empty plainObject will be used instead.
* **sort** *(bool, optional)* <br/> If true, will sort the keys before encoding ensuring that identical, but differently constructed objects will yield the same results.

##### All

A few options are applicable to every type of data.

* **limit** *(unsigned integer, optional)* <br/> The maximum amount of items encoded. When supplied, it will automatically keep track of and decode as many items as were initially encoded by the same method call.
* **preProc** *(function, optional)* <br/> A function to pass the items through before encoding, the new items will be whatever the function returns. The initial items do not have to be compliant with the encoding options.
* **postProc** *(function, optional)* <br/> A function to pass the items through after decoding, the new items will be whatever the function returns.

### Character sets
A character set is a set of characters that can be used for encoding and decoding purposes. There are a few ways to supply a character set to Polynar methods. A character set needs to cover at least one character.

##### Undefined
When no character set is supplied, the Base64 character set (as can be found below) will be used instead.

##### String
When supplying a string, its characters will be used as character set in the order they appear. No repeating characters are allowed.

For your convenience, Polynar comes with a number of predefined character sets. They can be found as properties of the Polynar object.
```
numeric: 0123456789
hex: 0123456789ABCDEF
alphaLower: abcdefghijklmnopqrstuvwxyz
alphaUpper: ABCDEFGHIJKLMNOPQRSTUVWXYZ
alpha: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
alphanumeric: 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
Base64: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
printable:  !"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~
htmlSafe:  !#$%'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~
```

##### Unsigned integer
When supplying an integer, the character set will be binary instead, starting from zero. The byte size will be equal to the number supplied.

Be aware that data processed this way may become corrupt or raise exceptions when using functions that are not binary safe. An example of this is XmlHttpRequest.

##### Array
By using an array that contains exactly two integers, the bounds of the binary range can be supplied in arbitrary order.
