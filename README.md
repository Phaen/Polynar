Polynar
=

Polynar is an easy to use encoding library for Javascript, utilizing polynary numbers for efficient and dynamic data storage, while even rivaling binary when similar storage is utilized.
Be aware that this is by no means a way of encryption, encoded data can easily be recovered even without knowledge of the applied encoding options.
		
Most data storage tools either force your to either settle for data limits equal to a power of two, making you waste twice as much space when it barely doesn't fit, or use an obscene amount of space when you already have to figure out a proper way of composing and parsing your data (Base64). Polynar removes all these limitations by using its own algorithm to store data by exactly the limits you supply it, massively limiting the amount of storage space wasted and even taking away the need to compose and parse your own data.

### Usage

The library can be utilized by adding it your project, either by use of the SCRIPT tag in a web environment or through require in NodeJS.
Adding the library to your project creates a Polynar object (by default assigned to the variable 'Polynar'), from which all functionality stems.

### Examples

###### JSFiddle Examples

[Object Encoding/Decoding](http://jsfiddle.net/Phaen/JWHt5/)

[Misc. Data Encoding/Decoding](http://jsfiddle.net/Phaen/VetvQ/)

###### Step-by-step

Let's walk through a simple object encoding example where we construct a template to encode parts of the [navigator object](https://developer.mozilla.org/en-US/docs/Web/API/Window.navigator).
To encode an object, we need to define a template for it. Let's just define a plainObject for now and create an encoder instance.
```Javascript
var data = new Polynar.encoder();
var tpl = {};
```

Let's start with the user agent, which can be found under the 'userAgent' property. User agents vary and some can be pretty long, let's settle for a maximum length of 2^12 (4096) as it's one of the hard limits that can be found.
As user agents can be customized and can thus contain pretty much any character, but in general they tend to exist out of just alphanumeric characters, space and '/():;.,'.
```Javascript
tpl.userAgent = {
	type: 'string',
	max: Math.pow( 2, 12 ),
	charset: Polynar.alphanumeric + '/():;., '
};
```

The 'appName' property is rather unique because in general, only three different values are found for it: 'Netscape', 'Microsoft Internet Explorer' and 'Opera'.
With that in mind, we can just settle for a list of possible items for this property.
```Javascript
tpl.appName = {
	type: 'item',
	list: [ 'Netscape', 'Microsoft Internet Explorer', 'Opera' ]
};
```

This becomes even easier for the 'cookieEnabled' property as it is a boolean, leaving us to only define it as such.
```Javascript
tpl.cookieEnabled = {
	type: 'boolean'
};
```

For the 'language' property, let's go with a little more functionality.
Its value can be just an ISO 639-1 code for a language, which are two lowercase lettters like 'nl', or have an addition for the dialect like 'en-GB'.
Say we are only interested in the initial two letter code, we can define an anonymous function to simply cut off anything past the initial two characters.
From then on, we could actually pass it as an item on a list of all ISO 639-1 language codes, but let's slack off for now and just define it as a two character lowalpha string. (Leaving strict mode off will already let Polynar cut it off at max length, but it's a bad practice.)
```Javascript
tpl.language = {
	type: 'string',
	preProc: function( s ) { return s.substr( 0, 2 ); },
	max: 2,
	charset: Polynar.lowalpha
};
```

Having defined all of the template, we can now define the encoding options for the navigator object itself.
For this particular case, we will want to enable sorting as we just randomly constructed the template and the property order is meaningless, while it may otherwise decode incorrectly if someone else slams the same template together in a different order.
```Javascript
var optionsNavigator = {
	type: 'object',
	template: tpl,
	sort: true
};
```

Say we want to append this data to an URL variable, we can pick an URL safe character set and append it to the URL just like that.
For now, let's just display the string in a prompt instead, so we can easily copy it and hang it above our bed as a trophy.

```Javascript
data.write( navigator, optionsNavigator );
prompt( 'Our encoded data string', data.toString( Polynar.urlSafe ) );
```

[A working JSFiddle of this example.](http://jsfiddle.net/Phaen/3N2s4/)

Decoding in Polynar adds very little extra effort beyond encoding.
The encoding options and complete template are already in place, the only thing left to do is to create a decoder instance with the encoded string and retrieve the data through the read method.
[Here is a JSFiddle](http://jsfiddle.net/Phaen/MvGC5/) that displays all the data decoded this way. You can paste in your own data string and see the magic happen right in front of your eyes (mind the quote marks!).

Keep in mind though that this is intended to serve only as an example. Browsers vary and can be completely customized, in this case possibly rendering our limits rather obstructive.

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
var encoder = new Polynar.encoder( [ strict ] );
```

Creates an encoder instance to which the data can be written. When not called as a constructor, it will do so itself instead and return the newly created instance. It accepts one argument.

* **strict** *(optional)* <br/> A boolean to turn strict mode on or off (defaults to false), can be manually adjusted by changing the *strict* property of the instance. In strict mode, Polynar will try to improvise by typecasting, etc. instead of throwing exceptions.

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
encoder.toString( charset );
```

The method to return the encoded data as string. It accepts one argument.

* **charset** <br/> The [character set](#character-sets) to output the encoded data under.

Because of the naming convention, an encoder instance will automatically return the encoded data whenever it is cast to string.

Be aware that byte size is an exponential function of the bit count, resulting in diminishing returns. Having a massive set is only a small advantage in string length over a large set.

###.decoder
> ```Javascript
var decoder = new Polynar.decoder( data, charset [, strict ] );
```

Returns a decoder instance from which the data can be read. When not called as a constructor, it will do so itself instead and return the newly created instance. It accepts two arguments.

* **data** <br/> The encoded data string to decode.
* **charset** <br/>  The [character set](#character-sets) under which to interpret the encoded data.
* **strict** *(optional)* <br/> A boolean to turn strict mode on or off (defaults to false), can be manually adjusted by changing the *strict* property of the instance. In strict mode, Polynar will try to improvise by typecasting, etc. instead of throwing exceptions.


Be aware that the encoded data fed to the decoder needs to be the exact same as was output by the encoder, no trailing spaces are allowed as they could all be part of the data.

###.decoder.read
> ```Javascript
decoder.read( encodingOptions [, count ] );
```

The method used for reading any kind of data from the decoder instance. It accepts two arguments.

* **encodingOptions** <br/> An [encodingOptions object](#encodingoptions), specifying the encoding options to decode the items with.
* **count** *(optional)* <br/> A positive integer with the amount of items to decode, will be ignored if the *limit* encoding option is set.

When decoding data, it is important to know that order matters. You must read the data in the exact same order, using the exact same options as it was previously written. The best way to do this is to predefine all [encodingOptions objects](#encodingoptions) you will use and refer to the same ones in both your encoding and decoding algorithm.

###.decoder.parse
> ```Javascript
encoder.parse( radix );
```

The underlaying method used by *decoder.read*. It parses and returns an integer. It accepts one argument.

* **radix** <br/> The radix to decode the integer from.

No sanitizing is utilized and using this method can improve efficiency, but is discouraged when lacking expertise. When used improperly, the decoding process may raise exceptions or produce corrupt data.

###The encodingOptions object
EncodingOptions is a plainObject containing the options as property-value pairs to be used in encoding and decoding processes. These options differ per data type that is encoded.

##### Numbers

* **type** *(string)* <br/> Must be set to *'number'*.
* **min** *(integer)* <br/> The lower bound of the range.
* **max** *(integer,boolean)* <br/> The upper bound of the range. This can alternatively also be set to the boolean *false*, leaving the upper bound open and allowing numbers of any size to be encoded. Saving numbers with no upper bound is more efficient when the gap between the average number and **max** would be large.
* **offset** *(integer,optional)* <br/> Alternatively specifies the range by overwriting **min** and **max** with *0*, and **offset**.
* **step** *(unsigned float, optional)* <br/> The step size of the range, will default to *1*.

Despite their naming convention, *min* and *max* can accept either range bound. As a result of this, **offset** can also be negative.

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
* **base** *(object/function/array, optional)* Decoding only. A base object to assign the properties and decoded values to. If ommited, a new plainObject will be created. If an anonymous function is supplied, it will be called to retrieve the object. If a named function is supplied, it will be called as a constructor to instantiate the object. If an array is supplied, the items will each be used as base for the decoded items. Array length must match the item count.
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
digit: 0123456789
hex: 0123456789ABCDEF
lowalpha: abcdefghijklmnopqrstuvwxyz
hialpha: ABCDEFGHIJKLMNOPQRSTUVWXYZ
alpha: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
alphanumeric: 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
Base64: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
<<<<<<< HEAD
<<<<<<< HEAD
printable:  !"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~
htmlSafe:  !#$%'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~
urlSafe: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$-_.+!*'()
=======
=======
>>>>>>> 8059f2e1bc11593a40a1022430a694b51167db76
printable:  !"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_\`abcdefghijklmnopqrstuvwxyz{|}~
htmlSafe:  !#$%'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_\`abcdefghijklmnopqrstuvwxyz{|}~
urlSafe: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$-_.+!*\'()
>>>>>>> 8059f2e1bc11593a40a1022430a694b51167db76
```

##### Unsigned integer

When supplying an integer, the character set will be binary instead, starting from zero. The byte size will be equal to the number supplied.

Be aware that data processed this way may become corrupt or raise exceptions when using functions that are not binary safe. An example of this is XmlHttpRequest.

##### Array
By using an array that contains exactly two integers, the bounds of the binary range can be supplied in arbitrary order.
